#!/usr/bin/env bash
# Runs the pytest suite (real PTY processes) in every cell of requirements/matrix-cells.txt, $MATRIX_JOBS (default
# three) cells at a time, inside the ci image. Prints one line per cell and exits non-zero if any cell fails.
set -euo pipefail
src=${1:?source directory}
out=${2:?log directory}
mkdir -p "$out"

run_cell() {
  local cell=$1 py=/opt/cells/$1/bin/python data status=0
  data=$(mktemp -d)
  (
    cd "$src"
    # Each cell gets its own database, home and lock file, so parallel cells never share a session lock.
    export PYTHONPATH="$src/src:$src/demo:$src/tests" DEMO_DATA_DIR="$data" TMPDIR="$data" HOME="$data"
    "$py" -c 'import sys, django; print(f"python {sys.version.split()[0]}, django {django.get_version()}")'
    "$py" demo/manage.py migrate -v0
    "$py" demo/manage.py seed_demo
    "$py" -m pytest -q -p no:cacheprovider -rs tests
  ) >"$out/$cell.log" 2>&1 || status=$?
  printf '%-24s exit=%s  %s  %s\n' "$cell" "$status" "$(head -1 "$out/$cell.log")" "$(tail -1 "$out/$cell.log")"
  return "$status"
}
export -f run_cell
export src out

awk '!/^#/ && NF {print $1}' "$src/requirements/matrix-cells.txt" | xargs -P "${MATRIX_JOBS:-3}" -I{} bash -c 'run_cell {}'
