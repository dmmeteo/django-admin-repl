import fcntl
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
import uuid
from collections.abc import Callable, Hashable, Iterator, Mapping
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import IO, Any

from .conf import Backend, Config

MARKER_ENV = "DJANGO_ADMIN_REPL_SESSION"
MAX_PENDING_INPUT = 1024 * 1024
READ_CHUNK = 64 * 1024

type OwnerId = Hashable  # the owner's user primary key


class State(StrEnum):
    RUNNING = "running"
    EXITED = "exited"
    ENDED = "ended"
    EXPIRED = "expired"


class ReplUnavailable(Exception):
    pass


class OutputLog:
    """Bounded output history addressed by absolute byte offsets since session start."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.start = 0
        self.data = bytearray()

    @property
    def end(self) -> int:
        return self.start + len(self.data)

    def append(self, chunk: bytes) -> None:
        self.data += chunk
        excess = len(self.data) - self.limit
        if excess <= 0:
            return
        # Prefer trimming at a line boundary so a replay rarely starts inside an escape sequence.
        newline = self.data.find(b"\n", excess, excess + 4096)
        cut = newline + 1 if newline >= 0 else excess
        del self.data[:cut]
        self.start += cut

    def read(self, cursor: int, limit: int = READ_CHUNK) -> tuple[int, bytes]:
        offset = max(cursor, self.start)
        index = offset - self.start
        return offset, bytes(self.data[index : index + limit])


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, UTC).isoformat()


Listener = Callable[[], None]


class ReplSession:
    def __init__(self, owner_id: OwnerId, backend: Backend, config: Config) -> None:
        self.id = uuid.uuid4().hex
        self.owner_id = owner_id
        self.backend = backend
        self.idle_timeout = config.idle_timeout
        self.started_at = time.time()
        self.state = State.RUNNING
        self.reason = ""
        self.exit_code: int | None = None
        self.output = OutputLog(config.replay_bytes)
        self._last_input = time.monotonic()
        self._last_input_wall = self.started_at
        self._lock = threading.Lock()
        self._listeners: set[Listener] = set()
        self._pending = bytearray()
        self._master: int | None = None
        self._proc: subprocess.Popen[bytes] | None = None
        self._thread: threading.Thread | None = None
        self._wake_r: int | None
        self._wake_w: int | None
        self._wake_r, self._wake_w = os.pipe()
        os.set_blocking(self._wake_w, False)

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc else None

    def spawn(self, cwd: str, env: Mapping[str, str]) -> None:
        master, slave = os.openpty()
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            self._proc = subprocess.Popen(
                [sys.executable, "-m", "django_admin_repl.pty_child", *self.backend.argv],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=cwd,
                env={**env, MARKER_ENV: self.id},
                start_new_session=True,
                close_fds=True,
            )
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        os.set_blocking(master, False)
        self._master = master
        self._thread = threading.Thread(
            target=self._pump, args=(master, self._proc), name=f"admin-repl-{self.id[:8]}", daemon=True
        )
        self._thread.start()

    def subscribe(self, callback: Listener) -> None:
        with self._lock:
            self._listeners.add(callback)

    def unsubscribe(self, callback: Listener) -> None:
        with self._lock:
            self._listeners.discard(callback)

    def read(self, cursor: int) -> tuple[int, bytes]:
        with self._lock:
            return self.output.read(cursor)

    @property
    def output_end(self) -> int:
        with self._lock:
            return self.output.end

    def write(self, data: bytes) -> bool:
        with self._lock:
            if self.state is not State.RUNNING or len(self._pending) + len(data) > MAX_PENDING_INPUT:
                return False
            self._pending += data
            self._last_input = time.monotonic()
            self._last_input_wall = time.time()
        self._wake()
        return True

    def resize(self, cols: int, rows: int) -> None:
        with self._lock:
            if self.state is State.RUNNING and self._master is not None:
                fcntl.ioctl(self._master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def idle_for(self, now: float | None = None) -> float:
        return (now if now is not None else time.monotonic()) - self._last_input

    def expire_if_idle(self, now: float | None = None) -> None:
        if self.state is State.RUNNING and self.idle_for(now) >= self.idle_timeout:
            self.terminate(State.EXPIRED, f"No input for {self.idle_timeout} s; the idle limit ended the process.")

    def terminate(self, state: State, reason: str, wait: float = 5.0) -> bool:
        with self._lock:
            if self.state is not State.RUNNING:
                return False
            self.state = state
            self.reason = reason
        self._signal_tree(signal.SIGHUP)
        self._wake()
        self._notify()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(wait)
        return True

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            running = self.state is State.RUNNING
            return {
                "id": self.id,
                "state": str(self.state),
                "reason": self.reason,
                "backend": self.backend.key,
                "backend_label": self.backend.label,
                "pid": self.pid,
                "exit_code": self.exit_code,
                "started_at": _iso(self.started_at),
                "idle_timeout": self.idle_timeout,
                "idle_deadline": _iso(self._last_input_wall + self.idle_timeout) if running else None,
                "output_start": self.output.start,
                "output_end": self.output.end,
            }

    def _wake(self) -> None:
        with self._lock:
            if self._wake_w is None:
                return
            try:
                os.write(self._wake_w, b"\0")
            except BlockingIOError:
                pass

    def _notify(self) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for callback in listeners:
            callback()

    def _pump(self, master: int, proc: subprocess.Popen[bytes]) -> None:
        wake_r = self._wake_r
        assert wake_r is not None
        try:
            while self.state is State.RUNNING and proc.poll() is None:
                with self._lock:
                    want_write = bool(self._pending)
                readable, writable, _ = select.select([master, wake_r], [master] if want_write else [], [], 0.5)
                if wake_r in readable:
                    os.read(wake_r, 4096)
                if master in readable:
                    try:
                        chunk = os.read(master, READ_CHUNK)
                    except BlockingIOError:
                        chunk = None
                    except OSError:
                        chunk = b""
                    if chunk == b"":
                        break
                    if chunk:
                        with self._lock:
                            self.output.append(chunk)
                        self._notify()
                if master in writable:
                    with self._lock:
                        data = bytes(self._pending[:READ_CHUNK])
                    try:
                        written = os.write(master, data)
                    except BlockingIOError:
                        written = 0
                    with self._lock:
                        del self._pending[:written]
        except OSError:
            pass
        finally:
            self._finish(master, proc)

    def _finish(self, master: int, proc: subprocess.Popen[bytes]) -> None:
        self._drain_remaining_output(master)
        try:
            exit_code = proc.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            self._signal_tree(signal.SIGKILL)
            exit_code = proc.wait()
        self._signal_tree(signal.SIGKILL)
        with self._lock:
            self._master = None
            self.exit_code = exit_code
            if self.state is State.RUNNING:
                self.state = State.EXITED
                self.reason = f"The REPL process exited with code {exit_code}."
            wake_r, wake_w, self._wake_r, self._wake_w = self._wake_r, self._wake_w, None, None
        for fd in (master, wake_r, wake_w):
            if fd is not None:
                os.close(fd)
        self._notify()

    def _drain_remaining_output(self, master: int) -> None:
        for _ in range(16):
            try:
                chunk = os.read(master, READ_CHUNK)
            except OSError:
                return
            if not chunk:
                return
            with self._lock:
                self.output.append(chunk)

    def _signal_tree(self, sig: signal.Signals) -> None:
        if self._proc is None:
            return
        targets: list[tuple[Callable[[int, int], None], int]] = [(os.killpg, self._proc.pid)]
        targets += [(os.kill, pid) for pid in self._marked_pids()]
        for kill, target in targets:
            try:
                kill(target, sig)
            except (ProcessLookupError, PermissionError):
                pass

    def _marked_pids(self) -> Iterator[int]:
        marker = f"{MARKER_ENV}={self.id}".encode()
        for entry in os.scandir("/proc"):
            if not entry.name.isdigit():
                continue
            try:
                with open(f"/proc/{entry.name}/environ", "rb") as handle:
                    if marker in handle.read().split(b"\0"):
                        yield int(entry.name)
            except OSError:
                continue


def child_environment() -> dict[str, str]:
    from django.conf import settings

    env = dict(os.environ)
    env.update(
        TERM="xterm-256color",
        COLORTERM="truecolor",
        PROMPT_TOOLKIT_NO_CPR="1",
        DJANGO_SETTINGS_MODULE=settings.SETTINGS_MODULE,
        PYTHONPATH=os.pathsep.join(path for path in sys.path if path),
    )
    env.setdefault("LANG", "C.UTF-8")
    return env


class SessionManager:
    def __init__(self, reap_interval: float = 0.5) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[OwnerId, ReplSession] = {}
        self._lock_file: IO[str] | None = None
        self._reaper: threading.Thread | None = None
        self._reap_interval = reap_interval

    def get(self, owner_id: OwnerId) -> ReplSession | None:
        with self._lock:
            return self._sessions.get(owner_id)

    def start(self, owner_id: OwnerId, backend: Backend, config: Config) -> tuple[ReplSession, bool]:
        with self._lock:
            self._claim_process(config.lock_path)
            current = self._sessions.get(owner_id)
            if current is not None and current.state is State.RUNNING:
                return current, False
            session = ReplSession(owner_id, backend, config)
            session.spawn(cwd=os.getcwd(), env=child_environment())
            self._sessions[owner_id] = session
            if self._reaper is None:
                self._reaper = threading.Thread(target=self._reap, name="admin-repl-reaper", daemon=True)
                self._reaper.start()
        return session, True

    def end(self, owner_id: OwnerId) -> ReplSession | None:
        session = self.get(owner_id)
        if session is not None:
            session.terminate(State.ENDED, "Ended by the user.")
        return session

    def end_all(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
        for session in sessions:
            session.terminate(State.ENDED, "Server shutdown.")

    def _claim_process(self, lock_path: Path) -> None:
        if self._lock_file is not None:
            return
        handle = open(lock_path, "a+")  # noqa: SIM115 - held open for the life of the process
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.close()
            raise ReplUnavailable(
                f"Another server process already hosts REPL sessions (lock {lock_path}). "
                "Run the REPL with a single ASGI server process."
            ) from None
        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()))
        handle.flush()
        self._lock_file = handle

    def _reap(self) -> None:
        while True:
            time.sleep(self._reap_interval)
            with self._lock:
                sessions = list(self._sessions.values())
            now = time.monotonic()
            for session in sessions:
                session.expire_if_idle(now)


manager = SessionManager()
