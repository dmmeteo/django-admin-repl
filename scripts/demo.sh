#!/usr/bin/env bash
# Runs the demo project on loopback. State lives in demo/.data (or $DEMO_DATA_DIR): the SQLite database, the
# secret key and a generated superuser login in login.json (mode 0600). Restarting keeps all three.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../demo"
export DEMO_DATA_DIR=${DEMO_DATA_DIR:-$PWD/.data}
mkdir -p "$DEMO_DATA_DIR"
chmod 700 "$DEMO_DATA_DIR"
python manage.py migrate --noinput -v0
python manage.py seed_demo
python manage.py demo_login
bind=${DEMO_BIND:-127.0.0.1}
port=${DEMO_PORT:-8000}
echo "Open http://$bind:$port/admin/ (Ctrl+C stops the server; the data and the login stay)."
exec daphne --bind "$bind" --port "$port" demo_project.asgi:application
