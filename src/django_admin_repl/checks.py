from collections.abc import Sequence
from typing import Any

from django.apps import AppConfig
from django.core.checks import CheckMessage, Error, Tags, register
from django.core.exceptions import ImproperlyConfigured

from .conf import Facts, get_config


@register(Tags.compatibility)
def check_admin_repl(app_configs: Sequence[AppConfig] | None, **kwargs: Any) -> list[CheckMessage]:
    try:
        config = get_config()
    except ImproperlyConfigured as error:
        return [Error(str(error), id="admin_repl.E001")]
    return [Error(problem, id="admin_repl.E002") for problem in config.problems(Facts.observe())]
