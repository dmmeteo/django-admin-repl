#!/usr/bin/env bash
# Runs the README quickstart in a clean copy of the source: everything between the quickstart markers except
# the clone, then logs in with the generated password, restarts the server and checks data and login survive.
set -euo pipefail
src=${1:?source directory}
out=${2:?log directory}
work=$(mktemp -d)
cp -r "$src" "$work/repo"
cd "$work/repo"
python3 - README.md >"$work/quickstart.sh" <<'PY'
import re, sys
block = re.search(r"<!-- quickstart -->\s*```bash\n(.*?)```", open(sys.argv[1]).read(), re.S).group(1)
lines = [line for line in block.splitlines() if line.strip() and not line.startswith(("git clone", "cd django-admin-repl"))]
assert lines[-1] == "scripts/demo.sh", lines
print("set -euo pipefail")
print("\n".join(lines[:-1]))
PY
echo "quickstart commands:"; sed -n '2,$p' "$work/quickstart.sh" | sed 's/^/  /'
bash "$work/quickstart.sh" >"$out/quickstart-install.log" 2>&1 || { tail -40 "$out/quickstart-install.log"; exit 1; }

serve() {
  (. .venv/bin/activate && exec scripts/demo.sh) >>"$out/quickstart-server.log" 2>&1 &
  server=$!
  for _ in $(seq 60); do
    .venv/bin/python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/admin/login/")' 2>/dev/null && return 0
    kill -0 "$server" 2>/dev/null || { tail -40 "$out/quickstart-server.log"; return 1; }
    sleep 1
  done
  tail -40 "$out/quickstart-server.log"
  return 1
}
stop() { kill "$server"; wait "$server" || true; }

serve
login_hash=$(sha256sum demo/.data/login.json | cut -d' ' -f1)
[ "$(stat -c %a demo/.data/login.json)" = 600 ] || { echo "login.json is not mode 0600" >&2; exit 1; }
.venv/bin/python "$src/scripts/ci/quickstart_client.py" demo/.data/login.json first
stop
serve
[ "$(sha256sum demo/.data/login.json | cut -d' ' -f1)" = "$login_hash" ] || { echo "restart replaced the login" >&2; exit 1; }
.venv/bin/python "$src/scripts/ci/quickstart_client.py" demo/.data/login.json restarted
stop
grep -Eq "interface=127\.0\.0\.1|TCP address 127\.0\.0\.1:8000" "$out/quickstart-server.log" || { echo "server did not bind loopback" >&2; exit 1; }
echo "quickstart: loopback only, data and login kept across a restart"
