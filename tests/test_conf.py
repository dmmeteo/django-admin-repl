import pytest
from django.test import override_settings

from django_admin_repl.checks import check_admin_repl
from django_admin_repl.conf import Facts, get_config

WITH_IPYTHON = Facts(ipython=True, django_extensions=False)
BARE = Facts(ipython=False, django_extensions=False)
EVERYTHING = Facts(ipython=True, django_extensions=True)


def test_auto_backend_prefers_ipython_and_falls_back_to_plain_python():
    config = get_config()
    assert config.default_backend(WITH_IPYTHON).argv == ("shell", "--interface", "ipython")
    assert config.default_backend(BARE).argv == ("shell", "--interface", "python")
    assert list(config.offered(BARE)) == ["python"]
    assert config.offered(EVERYTHING)["shell_plus"].argv == ("shell_plus", "--ipython")
    assert config.offered(Facts(ipython=False, django_extensions=True))["shell_plus"].argv == ("shell_plus", "--plain")


@override_settings(ADMIN_REPL={"BACKEND": "python", "ALLOWED_BACKENDS": ["python", "ipython"]})
def test_allowed_backends_limit_what_the_browser_is_offered():
    config = get_config()
    assert list(config.offered(EVERYTHING)) == ["python", "ipython"]
    assert config.default_backend(EVERYTHING).key == "python"


@override_settings(ADMIN_REPL={"BACKEND": "shell_plus"})
def test_explicit_unavailable_backend_is_reported_not_silently_replaced():
    assert get_config().problems(WITH_IPYTHON) == ["ADMIN_REPL['BACKEND'] = 'shell_plus' is not available here."]
    assert get_config().default_backend(WITH_IPYTHON) is None


def test_system_check_reports_shell_plus_without_django_extensions(settings):
    settings.ADMIN_REPL = {"BACKEND": "shell_plus"}
    settings.INSTALLED_APPS = [app for app in settings.INSTALLED_APPS if app != "django_extensions"]
    errors = check_admin_repl(None)
    assert [(error.id, error.msg) for error in errors] == [
        ("admin_repl.E002", "ADMIN_REPL['BACKEND'] = 'shell_plus' is not available here.")
    ]


@pytest.mark.parametrize(
    "raw, message",
    [
        ({"IDLE_TIMEOUT": 0}, "ADMIN_REPL['IDLE_TIMEOUT'] must be a positive integer, got 0."),
        (
            {"BACKEND": "bash"},
            "ADMIN_REPL['BACKEND'] must be 'auto' or one of python, ipython, shell_plus, got 'bash'.",
        ),
        ({"COMMAND": "/bin/sh"}, "Unknown ADMIN_REPL keys: COMMAND."),
        ({"SIDE": "top"}, "ADMIN_REPL['SIDE'] must be 'right' or 'left', got 'top'."),
    ],
)
def test_invalid_settings_fail_the_system_check(settings, raw, message):
    settings.ADMIN_REPL = raw
    assert [(error.id, error.msg) for error in check_admin_repl(None)] == [("admin_repl.E001", message)]
