from typing import Any

from django import template
from django.template.context import Context

from ..access import is_repl_user
from ..conf import get_config

register = template.Library()


def _enabled(context: Context) -> bool:
    request = context.get("request")
    return is_repl_user(getattr(request, "user", None)) and not context.get("is_popup")


@register.inclusion_tag("admin_repl/assets.html", takes_context=True)
def admin_repl_assets(context: Context) -> dict[str, Any]:
    return {"enabled": _enabled(context), "side": get_config().side}


@register.inclusion_tag("admin_repl/toggle.html", takes_context=True)
def admin_repl_toggle(context: Context) -> dict[str, Any]:
    return {"enabled": _enabled(context)}


@register.inclusion_tag("admin_repl/drawer.html", takes_context=True)
def admin_repl_drawer(context: Context) -> dict[str, Any]:
    if not _enabled(context):
        return {"enabled": False}
    config = get_config()
    return {
        "enabled": True,
        "side": config.side,
        "stream_path": config.stream_path,
        "csrf_token": context.get("csrf_token"),
    }
