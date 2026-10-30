import json
from collections.abc import Callable
from functools import wraps
from typing import Any

from django.http import JsonResponse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET, require_POST

from .access import AuthenticatedRequest, OwnerId, repl_owner
from .conf import Facts, get_config
from .sessions import ReplSession, ReplUnavailable, manager


def _error(status: int, message: str) -> JsonResponse:
    return JsonResponse({"error": message}, status=status)


def repl_user_required(
    view: Callable[[AuthenticatedRequest, OwnerId], JsonResponse],
) -> Callable[[AuthenticatedRequest], JsonResponse]:
    """Answers 401 or 403 unless an active superuser asks, and passes the view that user's session key."""

    @wraps(view)
    def wrapped(request: AuthenticatedRequest) -> JsonResponse:
        owner = repl_owner(request.user)
        if owner is None and not request.user.is_authenticated:
            return _error(401, "Log in as an active superuser to use the REPL.")
        if owner is None:
            return _error(403, "Only active superusers can use the REPL.")
        return view(request, owner)

    return never_cache(wrapped)


def _snapshot(session: ReplSession | None) -> dict[str, Any] | None:
    return session.snapshot() if session is not None else None


@require_GET
@repl_user_required
def state(request: AuthenticatedRequest, owner: OwnerId) -> JsonResponse:
    config = get_config()
    facts = Facts.observe()
    default = config.default_backend(facts)
    return JsonResponse(
        {
            "session": _snapshot(manager.get(owner)),
            "backends": [{"key": b.key, "label": b.label} for b in config.offered(facts).values()],
            "default_backend": default.key if default else None,
            "idle_timeout": config.idle_timeout,
        }
    )


@require_POST
@repl_user_required
def start(request: AuthenticatedRequest, owner: OwnerId) -> JsonResponse:
    config = get_config()
    facts = Facts.observe()
    try:
        payload = json.loads(request.body or b"{}")
    except ValueError:
        return _error(400, "Request body must be JSON.")
    requested = payload.get("backend") if isinstance(payload, dict) else None
    offered = config.offered(facts)
    if requested is None:
        backend = config.default_backend(facts)
    elif isinstance(requested, str) and requested in offered:
        backend = offered[requested]
    else:
        return _error(400, f"Backend {requested!r} is not available. Choose one of: {', '.join(offered)}.")
    if backend is None:
        return _error(503, "No REPL backend is available with the current settings.")
    try:
        session, created = manager.start(owner, backend, config)
    except ReplUnavailable as error:
        return _error(503, str(error))
    return JsonResponse({"session": session.snapshot(), "created": created}, status=201 if created else 200)


@require_POST
@repl_user_required
def end(request: AuthenticatedRequest, owner: OwnerId) -> JsonResponse:
    session = manager.end(owner)
    if session is None:
        return _error(404, "There is no REPL session to end.")
    return JsonResponse({"session": session.snapshot()})
