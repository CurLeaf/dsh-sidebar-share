#!/usr/bin/env bash
# Store a long-lived npm token in the macOS Keychain.
# Usage: bash scripts/npm-token.sh
# The token is read without echo and is never written to the repo or shell history.
set -euo pipefail

SERVICE="npm-dsh-sidebar-share"
TOKEN="${NPM_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  printf 'Paste npm granular/automation token (input hidden): '
  read -r -s TOKEN
  printf '\n'
fi

# Tokens never contain whitespace; a paste often carries a newline or spaces.
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"

if [[ -z "$TOKEN" ]]; then
  echo "empty token; nothing stored" >&2
  exit 1
fi

umask 077
CFG=$(mktemp -t npmrc-share.XXXXXX)
trap 'rm -f "$CFG"' EXIT
{
  printf 'registry=https://registry.npmjs.org/\n'
  printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN"
} > "$CFG"

security add-generic-password -a "$USER" -s "$SERVICE" -w "$TOKEN" -U >/dev/null
echo "stored in macOS Keychain: service=$SERVICE"

# Granular tokens scoped to a single package can fail /-/whoami while still
# being valid for publish. Store them anyway; release.sh tests on publish.
if npm --userconfig "$CFG" whoami >/dev/null 2>&1; then
  echo "token verified with npm whoami"
else
  echo "warning: npm whoami did not accept this token."
  echo "  publish-only/automation tokens may still work; release.sh will test it."
  echo "  if publish fails with E401/E404/EOTP, create a token with Read and write"
  echo "  for dsh-sidebar-share and, if offered, Bypass 2FA."
fi

echo "next: bash scripts/release.sh   (publishes 0.1.2; no login prompt)"
