#!/usr/bin/env bash
# Release gate. Each stage runs in a capped, non-root container and the first failure stops the gate:
#   1. static   Ruff check and format check, the ty gate on src/, a ty report over tests/ and demo/ (no network)
#   2. matrix   pytest with real PTY processes in every Python x Django cell (no network)
#   3. dist     wheel and sdist build, contents check, clean pip installs with and without extras (PyPI access)
#   4. demo     the README quickstart in a clean copy, including a restart (PyPI access, loopback server)
#   5. browser  Playwright journeys against throwaway demo containers on an internal network: cold start,
#               main journeys and a server restart on the right side, then the left side, then idle expiry
# Artifacts (logs, screenshots, built distributions) go to $ADMIN_REPL_STATE_DIR/verify/<time>-<revision>.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# One heavy run at a time. A caller that already holds the lock sets ADMIN_REPL_GATE_LOCK_HELD=1.
if [ "${ADMIN_REPL_GATE_LOCK_HELD:-}" != 1 ]; then
  mkdir -p "$(dirname "$LOCK_FILE")"
  status=0
  ADMIN_REPL_GATE_LOCK_HELD=1 flock -n -E 75 "$LOCK_FILE" bash "$0" "$@" || status=$?
  [ "$status" = 75 ] && echo "Another verify run holds $LOCK_FILE; leaving it alone." >&2
  exit "$status"
fi

revision=$(git -C "$REPO" rev-parse --short HEAD)
[ -z "$(git -C "$REPO" status --porcelain)" ] || revision="$revision-dirty"
mkdir -p "$STATE_ROOT/verify"
artifacts="$STATE_ROOT/verify/$(date +%Y%m%dT%H%M%S)-$revision"
work=$(mktemp -d "$STATE_ROOT/verify-work.XXXXXX")
net="$PREFIX-net"
app="$PREFIX-app"
subnet=${ADMIN_REPL_VERIFY_SUBNET:-10.230.92.0/29}
# An IP literal: Chromium upgrades single-label hosts such as http://app to https.
app_ip=${subnet%.*/*}.2
cleanup() {
  docker rm -f "$app" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  docker volume rm "$PREFIX-data" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
cleanup
mkdir -m 700 -p "$work" "$work/state" "$work/scratch" "$work/src"
mkdir -p "$artifacts"

log "revision $revision, artifacts $artifacts"
# The gate checks the files Git would commit: tracked and untracked-but-not-ignored, never ignored local state.
git -C "$REPO" ls-files -z --cached --others --exclude-standard \
  | tar -C "$REPO" --null --ignore-failed-read -T - -cf - 2>/dev/null | tar -C "$work/src" -xf -
ci_image=$(build ci "$PREFIX-ci:latest")
app_image=$(build runtime "$PREFIX-app:$revision")
browser_image=$(build "" "$PREFIX-browser:pw1.63.0" docker/browser.Dockerfile)
log "images ci=$ci_image app=$app_image browser=$browser_image"

ci() {
  local network=$1
  shift
  docker run --rm --init --read-only --tmpfs /tmp:rw,exec,size=128m --network "$network" \
    --memory "$CI_MEMORY" --memory-swap "$CI_MEMORY" --cpus 1.5 --pids-limit 256 -e "MATRIX_JOBS=$MATRIX_JOBS" "${HARDENING[@]}" --user "$(id -u):$(id -g)" \
    -e TMPDIR=/work -v "$work/scratch:/work" -v "$work/src:/src:ro" -v "$artifacts:/out" -w /src "$ci_image" "$@"
}

log "static: ruff check, ruff format --check, ty"
ci none sh -c '
  set -e
  /opt/dev/bin/ruff --version && /opt/dev/bin/ruff check --no-cache . && /opt/dev/bin/ruff format --no-cache --check .
  /opt/dev/bin/ty --version
  /opt/dev/bin/ty check --python /opt/dev src
  echo "ty report (not gating) over tests/ and demo/ with the py3.14-django6.1 cell:"
  /opt/dev/bin/ty check --python /opt/cells/py3.14-django6.1 --config "src.include=[\"tests\", \"demo\"]" \
    --extra-search-path demo --extra-search-path tests --output-format concise --exit-zero
' | tee "$artifacts/static.txt"

log "matrix: pytest in every Python x Django cell"
ci none bash scripts/ci/matrix.sh /src /out/matrix | tee "$artifacts/matrix.txt"

log "dist: build, inspect and install the wheel and sdist with pip"
ci bridge bash scripts/ci/dist.sh /src /out/dist | tee "$artifacts/dist.txt"

log "demo: README quickstart in a clean copy"
ci bridge bash scripts/ci/quickstart.sh /src /out | tee "$artifacts/quickstart.txt"

log "browser: Playwright journeys"
python3 - "$work/credentials.json" <<'PY'
import json, os, secrets, sys
roles = {"owner": "superuser", "other": "superuser", "staff": "staff", "inactive": "inactive-superuser"}
accounts = {name: {"username": f"verify-{name}", "role": role, "password": secrets.token_urlsafe(18)} for name, role in roles.items()}
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as handle:
    json.dump(accounts, handle)
PY
start_app() {
  docker rm -f "$app" >/dev/null 2>&1 || true
  docker volume rm "$PREFIX-data" >/dev/null 2>&1 || true
  run_app "$app" "$net" "$PREFIX-data" --ip "$app_ip" -e "DJANGO_ALLOWED_HOSTS=$app_ip" "$@" "$app_image"
  wait_ready "$app"
  python3 -c 'import json, sys; a = json.load(open(sys.argv[1])); print(json.dumps([a[n] for n in sys.argv[2:]]))' \
    "$work/credentials.json" "${ACCOUNTS[@]}" | ensure_accounts "$app"
}
browser() {
  docker run --rm --init --network "$net" --memory "$BROWSER_MEMORY" --memory-swap "$BROWSER_MEMORY" --cpus 1.0 --pids-limit 256 --shm-size 256m \
    "${HARDENING[@]}" --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e "BASE_URL=http://$app_ip:8000" -e CREDENTIALS_FILE=/secrets/credentials.json -e ARTIFACTS=/artifacts \
    -v "$work/credentials.json:/secrets/credentials.json:ro" -v "$work/state:/state" -v "$artifacts:/artifacts" \
    -v "$REPO/tests/browser/acceptance.mjs:/app/acceptance.mjs:ro" \
    "$browser_image" "$1" | tee -a "$artifacts/browser.txt"
}

docker network create --internal --subnet "$subnet" "$net" >/dev/null
ACCOUNTS=(owner other staff inactive)
log "right-hand drawer, fresh server: plain Python first, then widening after output"
start_app
browser cold
log "right-hand drawer, fresh server: main journeys"
start_app
browser main
log "restarting the demo server process"
docker restart --time 5 "$app" >/dev/null
wait_ready "$app"
browser after-restart

ACCOUNTS=(owner)
log "left-hand drawer (ADMIN_REPL_SIDE=left)"
start_app -e ADMIN_REPL_SIDE=left
browser left

log "short idle limit"
start_app -e ADMIN_REPL_IDLE_TIMEOUT=20
browser idle

passed=$(grep -c '^PASS ' "$artifacts/browser.txt")
cells=$(grep -c 'exit=0' "$artifacts/matrix.txt")
log "verify passed at $revision: $cells matrix cells, $passed browser checks, dist and quickstart smoke; artifacts $artifacts"
