import json
import os
import secrets
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Create the local demo superuser once, with a generated password kept in the data directory (mode 0600)."

    def handle(self, *args, **options):
        path = Path(settings.DATA_DIR) / "login.json"
        if not path.exists():
            login = {"username": "admin", "password": secrets.token_urlsafe(18)}
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as handle:
                json.dump(login, handle)
        login = json.loads(path.read_text())
        user_model = get_user_model()
        if not user_model.objects.filter(username=login["username"]).exists():
            user_model.objects.create_superuser(login["username"], password=login["password"])
            self.stdout.write(f"Created superuser {login['username']!r}.")
        self.stdout.write(f"Demo login: user {login['username']!r}, password in {path}")
