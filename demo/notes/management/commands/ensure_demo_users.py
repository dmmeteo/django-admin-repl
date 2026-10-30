import json
import sys

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.management.base import BaseCommand

ROLES = {
    "superuser": {"is_staff": True, "is_superuser": True, "is_active": True},
    "staff": {"is_staff": True, "is_superuser": False, "is_active": True},
    "inactive-superuser": {"is_staff": True, "is_superuser": True, "is_active": False},
}


class Command(BaseCommand):
    help = "Create or update demo accounts from a JSON list on stdin, so passwords never appear in argv."

    def handle(self, *args, **options):
        for account in json.load(sys.stdin):
            user, created = get_user_model().objects.get_or_create(username=account["username"])
            validate_password(account["password"], user)
            for flag, value in ROLES[account["role"]].items():
                setattr(user, flag, value)
            user.set_password(account["password"])
            user.save()
            self.stdout.write(f"{'Created' if created else 'Updated'} {account['role']} account {user.username}.")
