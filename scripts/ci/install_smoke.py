"""Smoke-checks an installed django-admin-repl outside the source tree.

Usage: python install_smoke.py <expected backends, comma-separated>

It configures a throwaway project, runs Django's system checks, finds the packaged static files and templates,
then starts a real PTY session and runs call_command("check") inside it.
"""

import os
import sys
import tempfile
import time
from pathlib import Path

expected = set(sys.argv[1].split(","))
work = Path(tempfile.mkdtemp())
extra_apps = ["django_extensions"] if "shell_plus" in expected else []
(work / "smoke_settings.py").write_text(
    f"""
SECRET_KEY = "install-smoke-not-secret"
INSTALLED_APPS = [
    "django.contrib.admin", "django.contrib.auth", "django.contrib.contenttypes", "django.contrib.sessions",
    "django.contrib.messages", "django.contrib.staticfiles", "django_admin_repl", *{extra_apps!r},
]
MIDDLEWARE = [
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
]
TEMPLATES = [{{"BACKEND": "django.template.backends.django.DjangoTemplates", "APP_DIRS": True,
              "OPTIONS": {{"context_processors": ["django.template.context_processors.request",
                                                 "django.contrib.auth.context_processors.auth",
                                                 "django.contrib.messages.context_processors.messages"]}}}}]
DATABASES = {{"default": {{"ENGINE": "django.db.backends.sqlite3", "NAME": {str(work / "db.sqlite3")!r}}}}}
ROOT_URLCONF = "smoke_settings"
urlpatterns = []
STATIC_URL = "static/"
USE_TZ = True
ADMIN_REPL = {{"LOCK_PATH": {str(work / "repl.lock")!r}}}
"""
)
sys.path.insert(0, str(work))
os.environ["DJANGO_SETTINGS_MODULE"] = "smoke_settings"
os.chdir(work)

import django  # noqa: E402

django.setup()

from django.contrib.staticfiles import finders  # noqa: E402
from django.core.management import call_command  # noqa: E402
from django.template.loader import get_template  # noqa: E402

import django_admin_repl  # noqa: E402
from django_admin_repl.conf import Facts, get_config  # noqa: E402
from django_admin_repl.sessions import manager  # noqa: E402

package = Path(django_admin_repl.__file__).parent
assert "site-packages" in str(package), f"imported from the source tree: {package}"
call_command("check", fail_level="WARNING")
for asset in ("drawer.js", "drawer.css", "boot.js", "vendor/ghostty-web/ghostty-vt.wasm", "vendor/ghostty-web/LICENSE"):
    assert finders.find(f"admin_repl/{asset}"), f"missing static file admin_repl/{asset}"
for name in ("assets", "drawer", "toggle"):
    get_template(f"admin_repl/{name}.html")

config = get_config()
offered = config.offered(Facts.observe())
assert set(offered) == expected, f"offered {sorted(offered)}, expected {sorted(expected)}"

session, _ = manager.start("install-smoke", offered["python"], config)
deadline = time.monotonic() + 60
script = b'from django.core.management import call_command; call_command("check")\r'
sent = False
while time.monotonic() < deadline:
    text = session.read(0)[1].decode("utf-8", "replace")
    if not sent and ">>> " in text:
        session.write(script)
        sent = True
    if "System check identified no issues" in text:
        break
    time.sleep(0.1)
else:
    raise AssertionError(f"call_command('check') never answered in the REPL:\n{text[-800:]}")
manager.end("install-smoke")
print(f"ok: django {django.get_version()}, backends {','.join(sorted(offered))}, call_command('check') in a PTY REPL")
