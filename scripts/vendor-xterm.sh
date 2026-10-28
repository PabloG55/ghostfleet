#!/usr/bin/env bash
# scripts/vendor-xterm.sh — refetch the web terminal's xterm.js into web/, from the npm
# tarballs pinned below, and refuse anything whose bytes are not the ones pinned.
#
#     scripts/vendor-xterm.sh            fetch, verify, copy into web/
#     scripts/vendor-xterm.sh --check    verify the files already in web/ (no network)
#
# WHY VENDORED AND NOT A DEPENDENCY. The client is served as files from web/, and the suite
# has no install step (CI runs it straight from a checkout). preact goes through vite only
# because a component has to be compiled; xterm.js is already an ES module, so the file the
# phone fetches IS the file npm ships, and the only thing worth adding is a guarantee that it
# still is. Three files, three digests — the suite reruns --check on every run, so a vendored
# file edited by hand (or swapped for another version) goes red rather than shipping.
#
# To move to a new version: change a VERSION and its INTEGRITY below (npm view <pkg>@<v>
# dist.integrity), run this script, paste the printed sha256 lines into FILES, and bump
# web/sw.js's VERSION, because these are precached.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/web"

XTERM_VERSION=6.0.0
XTERM_INTEGRITY='sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg=='
FIT_VERSION=0.11.0
FIT_INTEGRITY='sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g=='

# web/<name>  <-  <package>@<version>:<path in the tarball>  sha256
FILES=(
  "xterm.js|@xterm/xterm|package/lib/xterm.mjs|b336ec65a086c056d4804b3d4c2347da5663d3f23c3f25be866467bd8857ad59"
  "xterm.css|@xterm/xterm|package/css/xterm.css|854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6"
  "xterm-fit.js|@xterm/addon-fit|package/lib/addon-fit.mjs|2d87e1bddc73be9111de8beee5370c3bb7aac9c94e18e6f245f02ca741ef1769"
)

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

if [ "${1:-}" = --check ]; then
  bad=0
  for f in "${FILES[@]}"; do
    IFS='|' read -r name _ _ want <<< "$f"
    got="$(sha "$WEB/$name" 2>/dev/null || echo missing)"
    if [ "$got" != "$want" ]; then echo "web/$name: $got, pinned $want"; bad=1; fi
  done
  exit "$bad"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
fetch() {                              # $1 package  $2 version  $3 integrity  -> unpacked dir
  local dir="$TMP/$(printf '%s' "$1" | tr '/@' '__')"
  mkdir -p "$dir"
  ( cd "$dir" && npm pack --silent "$1@$2" >/dev/null )
  local tgz; tgz="$(ls "$dir"/*.tgz)"
  local got; got="sha512-$(openssl dgst -sha512 -binary "$tgz" | openssl base64 -A)"
  [ "$got" = "$3" ] || { echo "vendor-xterm: $1@$2 tarball is $got, pinned $3 — refusing" >&2; exit 1; }
  tar -xzf "$tgz" -C "$dir"
  printf '%s' "$dir"
}
XT="$(fetch @xterm/xterm "$XTERM_VERSION" "$XTERM_INTEGRITY")"
FT="$(fetch @xterm/addon-fit "$FIT_VERSION" "$FIT_INTEGRITY")"
for f in "${FILES[@]}"; do
  IFS='|' read -r name pkg src _ <<< "$f"
  case "$pkg" in @xterm/xterm) d="$XT" ;; *) d="$FT" ;; esac
  cp "$d/$src" "$WEB/$name"
  echo "$name $(sha "$WEB/$name")"
done
