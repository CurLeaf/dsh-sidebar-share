#!/usr/bin/env bash
# One-shot release: test, verify the version is new, publish to npm, verify.
#
# Usage:
#   bash scripts/release.sh          publish package.json's current version
#   bash scripts/release.sh --bump   bump patch, then publish
#
# Auth resolution order:
#   1. NPM_TOKEN in the environment
#   2. macOS Keychain service "npm-dsh-sidebar-share" (see scripts/npm-token.sh)
#   3. the normal npm login in ~/.npmrc
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,14p' "$0"
  exit 0
fi

SERVICE="npm-dsh-sidebar-share"
TOKEN="${NPM_TOKEN:-}"
CFG=""
PUB=""
cleanup() {
  if [[ -n "$CFG" ]]; then rm -f "$CFG"; fi
  if [[ -n "$PUB" ]]; then rm -f "$PUB"; fi
}
trap cleanup EXIT

if [[ -z "$TOKEN" ]]; then
  TOKEN=$(security find-generic-password -a "$USER" -s "$SERVICE" -w 2>/dev/null || true)
fi

umask 077
PUB=$(mktemp -t npmrc-public.XXXXXX)
printf 'registry=https://registry.npmjs.org/\n' > "$PUB"
VIEW=(npm --userconfig "$PUB")
NPM=(npm)

if [[ -n "$TOKEN" ]]; then
  CFG=$(mktemp -t npmrc-share.XXXXXX)
  {
    printf 'registry=https://registry.npmjs.org/\n'
    printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN"
  } > "$CFG"
  NPM=(npm --userconfig "$CFG")
  echo "using stored npm token"
elif ! npm whoami >/dev/null 2>&1; then
  echo "npm is not authenticated." >&2
  echo "Create a granular or automation token at https://www.npmjs.com/settings/curleaf/tokens" >&2
  echo "then run: bash scripts/npm-token.sh" >&2
  exit 1
fi

if [[ "${1:-}" == "--bump" ]]; then
  npm version patch --no-git-tag-version >/dev/null
fi

PKG=$(node -p "require('./package.json').name")
VER=$(node -p "require('./package.json').version")

if "${VIEW[@]}" view "$PKG@$VER" version >/dev/null 2>&1; then
  echo "$PKG@$VER is already published; use --bump or edit the version first" >&2
  exit 1
fi

echo "== checks =="
node --check dist/client.js
node test/harness.mjs
"${NPM[@]}" pack --dry-run >/dev/null
echo "== publish $PKG@$VER =="

if ! "${NPM[@]}" publish --access public; then
  echo "publish failed." >&2
  echo "If npm asked for OTP, create the token with Bypass 2FA, or use an automation token." >&2
  echo "If it returned E401/E404, recreate the token with Read and write for $PKG." >&2
  exit 1
fi

echo "== verify $PKG@$VER =="
LISTED=0
for ((attempt = 0; attempt < 30; attempt++)); do
  if "${VIEW[@]}" view "$PKG@$VER" version >/dev/null 2>&1; then
    LISTED=1
    break
  fi
  sleep 3
done

if [[ "$LISTED" -eq 1 ]]; then
  "${VIEW[@]}" view "$PKG@$VER" version
else
  echo "npm accepted the publish, but the registry has not listed $VER yet."
  echo "It is usually visible within a minute: https://www.npmjs.com/package/$PKG"
fi

echo "https://www.npmjs.com/package/$PKG"
echo
echo "The desktop profile currently links this folder; reload the DSH window (Cmd+R)"
echo "to load the same code without re-installing. On another machine:"
echo "  dsh plugin --profile desktop add $PKG"
