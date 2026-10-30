from django.apps import AppConfig


class AdminReplConfig(AppConfig):
    name = "django_admin_repl"
    label = "admin_repl"
    verbose_name = "Admin REPL"

    def ready(self) -> None:
        from . import checks  # noqa: F401
