# Shared helpers for scripts/verify.sh. Every container, network and volume carries $PREFIX, runs as a
# non-root user with all capabilities dropped and a memory, CPU and process cap, and publishes no port.
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PREFIX=${ADMIN_REPL_PREFIX:-django-admin-repl-verify}
STATE_ROOT=${ADMIN_REPL_STATE_DIR:-$REPO/.verify}
LOCK_FILE=${ADMIN_REPL_LOCK_FILE:-$STATE_ROOT/heavy.lock}
APP_LIMITS=(--memory 480m --memory-swap 480m --cpus 0.45 --pids-limit 104)
# Caps for the tool and browser containers; lower them (and the parallel matrix cells) on a busy host.
CI_MEMORY=${ADMIN_REPL_CI_MEMORY:-1536m}
BROWSER_MEMORY=${ADMIN_REPL_BROWSER_MEMORY:-1g}
MATRIX_JOBS=${ADMIN_REPL_MATRIX_JOBS:-3}
HARDENING=(--cap-drop ALL --security-opt no-new-privileges)

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

build() {
  local target=$1 tag=$2 dockerfile=${3:-docker/Dockerfile} output status=0
  output=$(DOCKER_BUILDKIT=0 docker build --quiet --memory=1536m --memory-swap=1536m --cpu-quota=150000 \
    --cpu-period=100000 -f "$REPO/$dockerfile" ${target:+--target "$target"} -t "$tag" "$REPO" 2>&1) || status=$?
  if [ "$status" != 0 ]; then
    printf '%s\n' "$output" >&2
    return "$status"
  fi
  docker image inspect "$tag" --format '{{.Id}}'
}

run_app() {
  local name=$1 network=$2 data=$3
  shift 3
  docker run -d --name "$name" --network "$network" --init --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=64m -v "$data:/data" --user 10001:10001 \
    "${HARDENING[@]}" "${APP_LIMITS[@]}" "$@" >/dev/null
}

READY_PROBE='
import http.client
connection = http.client.HTTPConnection("127.0.0.1", 8000, timeout=2)
connection.request("GET", "/admin/login/")
connection.getresponse()
'

wait_ready() {
  local name=$1
  for _ in $(seq 60); do
    if docker exec "$name" python -c "$READY_PROBE" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  docker logs --tail 40 "$name" >&2
  return 1
}

# Reads a JSON list of {username, role, password} on stdin.
ensure_accounts() {
  docker exec -i "$1" python manage.py ensure_demo_users >/dev/null
}
