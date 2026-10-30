from importlib import import_module
from types import SimpleNamespace

from django.conf import settings
from django.contrib.auth import get_user
from django.contrib.auth.base_user import AbstractBaseUser
from django.contrib.auth.models import AnonymousUser, PermissionsMixin
from django.http import HttpRequest

from .sessions import OwnerId


class AuthenticatedRequest(HttpRequest):
    """A request AuthenticationMiddleware has run on. Django sets `user` at runtime, not in its type."""

    user: AbstractBaseUser | AnonymousUser


def repl_owner(user: AbstractBaseUser | AnonymousUser | None) -> OwnerId | None:
    """The user's primary key when they may use the REPL: an authenticated, active superuser."""
    # A user model without PermissionsMixin has no superusers, so it never gets the REPL.
    is_superuser = isinstance(user, AbstractBaseUser) and isinstance(user, PermissionsMixin) and user.is_superuser
    return user.pk if is_superuser and user.is_active else None


def is_repl_user(user: AbstractBaseUser | AnonymousUser | None) -> bool:
    return repl_owner(user) is not None


def current_repl_user_id(session_key: str | None) -> OwnerId | None:
    """Re-read the Django session so logout, deactivation or a password change revoke a live stream."""
    if not session_key:
        return None
    store = import_module(settings.SESSION_ENGINE).SessionStore(session_key)
    return repl_owner(get_user(SimpleNamespace(session=store)))
