#!/usr/bin/env bash
# Re-vendors the pinned ghostty-web release into the app's static files and verifies npm's published integrity.
set -euo pipefail
VERSION=0.4.0
INTEGRITY=sha512-0puDBik2qapbD/QQBW9o5ZHfXnZBqZWx/ctBiVtKZ6ZLds4NYb+wZuw1cRLXZk9zYovIQ908z3rvFhexAvc5Hg==
repo=$(cd "$(dirname "$0")/.." && pwd)
dest="$repo/src/django_admin_repl/static/admin_repl/vendor/ghostty-web"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/package.tgz" "https://registry.npmjs.org/ghostty-web/-/ghostty-web-$VERSION.tgz"
actual="sha512-$(openssl dgst -sha512 -binary "$work/package.tgz" | base64 -w0)"
[ "$actual" = "$INTEGRITY" ] || { echo "ghostty-web $VERSION integrity mismatch: $actual" >&2; exit 1; }
tar -xzf "$work/package.tgz" -C "$work"
rm -rf "$dest" && mkdir -p "$dest"
cp "$work/package/dist/ghostty-web.js" "$work/package/dist/__vite-browser-external-2447137e.js" \
   "$work/package/ghostty-vt.wasm" "$work/package/LICENSE" "$work/package/README.md" "$dest/"
cat > "$dest/PROVENANCE.md" <<NOTE
# ghostty-web $VERSION

Vendored unmodified from the npm package \`ghostty-web@$VERSION\` (https://github.com/coder/ghostty-web, MIT, see LICENSE).

- Tarball: https://registry.npmjs.org/ghostty-web/-/ghostty-web-$VERSION.tgz
- npm integrity: \`$INTEGRITY\`
- Files: \`dist/ghostty-web.js\`, \`dist/__vite-browser-external-2447137e.js\`, \`ghostty-vt.wasm\`, \`LICENSE\`, \`README.md\`

Regenerate with \`scripts/vendor-ghostty.sh\`.
NOTE
(cd "$dest" && sha256sum ghostty-web.js ghostty-vt.wasm __vite-browser-external-2447137e.js)
