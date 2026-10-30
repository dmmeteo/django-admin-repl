import importlib.util
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from django.apps import apps
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

AUTO = "auto"
DEFAULT_IDLE_TIMEOUT = 4 * 60 * 60
DEFAULT_REPLAY_BYTES = 512 * 1024
DEFAULT_STREAM_PATH = "/admin/repl/stream/"
SIDES = ("right", "left")
type Side = Literal["right", "left"]


@dataclass(frozen=True)
class Facts:
    ipython: bool
    django_extensions: bool

    @classmethod
    def observe(cls) -> "Facts":
        return cls(
            ipython=importlib.util.find_spec("IPython") is not None,
            django_extensions=apps.is_installed("django_extensions"),
        )


@dataclass(frozen=True)
class Backend:
    key: str
    label: str
    argv: tuple[str, ...]


def available_backends(facts: Facts) -> dict[str, Backend]:
    backends = [Backend("python", "Django shell (Python)", ("shell", "--interface", "python"))]
    if facts.ipython:
        backends.append(Backend("ipython", "Django shell (IPython)", ("shell", "--interface", "ipython")))
    if facts.django_extensions:
        interface = "--ipython" if facts.ipython else "--plain"
        label = "shell_plus (IPython)" if facts.ipython else "shell_plus (Python)"
        backends.append(Backend("shell_plus", label, ("shell_plus", interface)))
    return {backend.key: backend for backend in backends}


KNOWN_BACKENDS = ("python", "ipython", "shell_plus")


@dataclass(frozen=True)
class Config:
    backend: str
    allowed: tuple[str, ...] | None
    idle_timeout: int
    replay_bytes: int
    stream_path: str
    lock_path: Path
    side: Side

    def offered(self, facts: Facts) -> dict[str, Backend]:
        available = available_backends(facts)
        keys = self.allowed if self.allowed is not None else tuple(available)
        return {key: available[key] for key in keys if key in available}

    def default_backend(self, facts: Facts) -> Backend | None:
        offered = self.offered(facts)
        if self.backend != AUTO:
            return offered.get(self.backend)
        for key in ("ipython", "python", "shell_plus"):
            if key in offered:
                return offered[key]
        return None

    def problems(self, facts: Facts) -> list[str]:
        available = available_backends(facts)
        found = []
        if self.backend != AUTO and self.backend not in available:
            found.append(f"ADMIN_REPL['BACKEND'] = {self.backend!r} is not available here.")
        if self.allowed is not None:
            if self.backend != AUTO and self.backend not in self.allowed:
                found.append(f"ADMIN_REPL['BACKEND'] = {self.backend!r} is not listed in ALLOWED_BACKENDS.")
            missing = [key for key in self.allowed if key not in available]
            if missing:
                found.append(f"ADMIN_REPL['ALLOWED_BACKENDS'] names unavailable backends: {', '.join(missing)}.")
        if not self.offered(facts):
            found.append("No REPL backend is available with the current ADMIN_REPL settings.")
        return found


def _positive_int(raw: object, name: str) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
        raise ImproperlyConfigured(f"ADMIN_REPL[{name!r}] must be a positive integer, got {raw!r}.")
    return raw


def get_config() -> Config:
    raw = dict(getattr(settings, "ADMIN_REPL", {}))
    unknown = set(raw) - {
        "BACKEND",
        "ALLOWED_BACKENDS",
        "IDLE_TIMEOUT",
        "REPLAY_BYTES",
        "STREAM_PATH",
        "LOCK_PATH",
        "SIDE",
    }
    if unknown:
        raise ImproperlyConfigured(f"Unknown ADMIN_REPL keys: {', '.join(sorted(unknown))}.")

    backend = raw.get("BACKEND", AUTO)
    if backend != AUTO and backend not in KNOWN_BACKENDS:
        raise ImproperlyConfigured(
            f"ADMIN_REPL['BACKEND'] must be 'auto' or one of {', '.join(KNOWN_BACKENDS)}, got {backend!r}."
        )

    allowed = raw.get("ALLOWED_BACKENDS")
    if allowed is not None:
        if isinstance(allowed, str) or not all(isinstance(key, str) for key in allowed):
            raise ImproperlyConfigured("ADMIN_REPL['ALLOWED_BACKENDS'] must be a list of backend names or None.")
        allowed = tuple(allowed)
        unknown_keys = [key for key in allowed if key not in KNOWN_BACKENDS]
        if unknown_keys:
            raise ImproperlyConfigured(f"ADMIN_REPL['ALLOWED_BACKENDS'] has unknown names: {', '.join(unknown_keys)}.")

    stream_path = raw.get("STREAM_PATH", DEFAULT_STREAM_PATH)
    if not (isinstance(stream_path, str) and stream_path.startswith("/") and stream_path.endswith("/")):
        raise ImproperlyConfigured("ADMIN_REPL['STREAM_PATH'] must start and end with '/'.")

    lock_path = raw.get("LOCK_PATH") or Path(tempfile.gettempdir()) / "django-admin-repl.lock"

    side = raw.get("SIDE", "right")
    if side not in SIDES:
        raise ImproperlyConfigured(f"ADMIN_REPL['SIDE'] must be 'right' or 'left', got {side!r}.")

    return Config(
        backend=backend,
        allowed=allowed,
        idle_timeout=_positive_int(raw.get("IDLE_TIMEOUT", DEFAULT_IDLE_TIMEOUT), "IDLE_TIMEOUT"),
        replay_bytes=_positive_int(raw.get("REPLAY_BYTES", DEFAULT_REPLAY_BYTES), "REPLAY_BYTES"),
        stream_path=stream_path,
        lock_path=Path(lock_path),
        side=side,
    )
