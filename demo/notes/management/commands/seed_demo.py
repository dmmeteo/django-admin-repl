from django.core.management.base import BaseCommand

from notes.models import Note

SYNTHETIC_NOTES = [
    ("Welcome to the admin REPL demo", Note.Status.DONE),
    ("Try Note.objects.filter(status='draft')", Note.Status.DRAFT),
    ("Rename me from the shell, then reload", Note.Status.DRAFT),
    ("Synthetic data only", Note.Status.REVIEW),
]


class Command(BaseCommand):
    help = "Create the synthetic demo notes once."

    def handle(self, *args, **options):
        if Note.objects.exists():
            self.stdout.write("Demo notes already present.")
            return
        Note.objects.bulk_create(Note(title=title, status=status) for title, status in SYNTHETIC_NOTES)
        self.stdout.write(f"Created {len(SYNTHETIC_NOTES)} synthetic notes.")
