#!/bin/sh
set -eu
mkdir -p "$HOME"
python manage.py migrate --noinput
python manage.py seed_demo
exec daphne --bind 0.0.0.0 --port 8000 demo_project.asgi:application
