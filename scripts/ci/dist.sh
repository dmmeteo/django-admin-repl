#!/usr/bin/env bash
# Builds the wheel and sdist from a copy of the source, checks what they ship, then installs each one with
# ordinary pip into a fresh virtual environment (no extras, [ipython], [shell-plus]) and smoke-tests it.
set -euo pipefail
src=${1:?source directory}
out=${2:?output directory}
mkdir -p "$out"
work=$(mktemp -d)
cp -r "$src" "$work/src"
"${DEV_PYTHON:-/opt/dev/bin/python}" -m build --outdir "$out" "$work/src" >"$out/build.log" 2>&1 || { cat "$out/build.log"; exit 1; }
wheel=$(ls "$out"/django_admin_repl-*.whl)
sdist=$(ls "$out"/django_admin_repl-*.tar.gz)
echo "built $(basename "$wheel") $(basename "$sdist")"

python - "$wheel" "$sdist" <<'PY'
import sys, tarfile, zipfile
wheel = set(zipfile.ZipFile(sys.argv[1]).namelist())
sdist = {name.split("/", 1)[1] for name in tarfile.open(sys.argv[2]).getnames() if "/" in name}
static = "django_admin_repl/static/admin_repl/"
need_wheel = [static + f for f in ("boot.js", "drawer.js", "drawer.css", "vendor/ghostty-web/ghostty-vt.wasm",
              "vendor/ghostty-web/ghostty-web.js", "vendor/ghostty-web/LICENSE", "vendor/ghostty-web/PROVENANCE.md")]
need_wheel += [f"django_admin_repl/templates/admin_repl/{n}.html" for n in ("assets", "drawer", "toggle")]
missing = [f for f in need_wheel if f not in wheel]
missing += [f for f in ("LICENSE", "README.md", "pyproject.toml") if f not in sdist]
assert any(f.endswith(".dist-info/licenses/LICENSE") for f in wheel), "wheel lacks the project license"
private = (".data/", ".verify/", "db.sqlite3", "login.json", "secret_key", "credentials")
leaked = [f for f in wheel | sdist if any(marker in f for marker in private)]
assert not missing, f"missing from the distributions: {missing}"
assert not leaked, f"development files in the distributions: {leaked}"
print(f"wheel {len(wheel)} files, sdist {len(sdist)} files: static assets, templates and licenses present")
PY

install() {
  local name=$1 target=$2 expected=$3 env="$work/env-$1"
  python -m venv "$env"
  "$env/bin/pip" install -q "$target" >"$out/pip-$name.log" 2>&1 || { cat "$out/pip-$name.log"; return 1; }
  (cd "$work" && "$env/bin/python" "$src/scripts/ci/install_smoke.py" "$expected") | sed "s/^/$name: /"
}
install wheel "$wheel" python
install wheel-ipython "$wheel[ipython]" python,ipython
install wheel-shell-plus "$wheel[shell-plus]" python,shell_plus
install sdist "$sdist" python
