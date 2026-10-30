#!/usr/bin/env bash
# Save the alert webhook to ${ARB_CONFIG_DIR}/alerts.env (mode 600), send a test POST, restart the bot if it runs.
#   set-alerts.sh <https://webhook-url>                        prompt (hidden) for the auth header or bare token
#   set-alerts.sh <https://webhook-url> --header-from-env VAR  take it from $VAR (e.g. a secret an agent platform injected)
#   set-alerts.sh <https://webhook-url> --no-auth              the URL itself carries the secret
#   set-alerts.sh --off                                        remove the webhook
# A bare token becomes "Authorization: Bearer <token>". The bot POSTs only when a chain's findings change.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${ARB_CONFIG_DIR:-${HOME}/.config/aave-oracle-lag-arb}"
ALERTS_FILE="${CONFIG_DIR}/alerts.env"
die() { echo "$*" >&2; exit 1; }

restart_if_running() {
  if "${DIR}/trader.sh" status | head -1 | grep -q '^running'; then
    "${DIR}/trader.sh" stop >/dev/null && "${DIR}/trader.sh" start
  fi
}

url="" from="" auth=1
while [ $# -gt 0 ]; do
  case "$1" in
    --off) rm -f "${ALERTS_FILE}"; echo "webhook removed"; restart_if_running; exit 0 ;;
    --header-from-env) from="${2:?}"; [[ "${from}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "not a variable name: ${from}"; shift 2 ;;
    --no-auth) auth=0; shift ;;
    -h | --help) sed -n '2,7p' "$0"; exit 0 ;;
    https://*) url="$1"; shift ;;
    *) die "expected an https:// URL or an option (see --help)" ;;
  esac
done
[ -n "${url}" ] || die "give the webhook URL (https://...)"

header=""
if [ "${auth}" = 1 ]; then
  if [ -n "${from}" ]; then header="${!from:-}"; [ -n "${header}" ] || die "\$${from} is empty or not set"
  else read -r -s -p "auth header or token (hidden): " header </dev/tty; echo; fi
  case "${header}" in *:*) ;; *) header="Authorization: Bearer ${header}" ;; esac
fi

mkdir -p "${CONFIG_DIR}" && chmod 700 "${CONFIG_DIR}"
(umask 077; printf 'ALERT_WEBHOOK_URL=%q\nALERT_WEBHOOK_HEADER=%q\n' "${url}" "${header}" >"${ALERTS_FILE}")
echo "saved to ${ALERTS_FILE} (mode 600)"

# test POST with the same shape the bot sends, but no findings
body='{"source":"aave-u-eth","test":true,"findings":[],"new":[],"resolved":[]}'
post() { curl -s -o /dev/null -w '%{http_code}' -m 20 -X POST -H 'Content-Type: application/json' "$@" -d "${body}" "${url}" || true; }
if [ -n "${header}" ]; then code="$(post -H @<(printf '%s\n' "${header}"))"   # header via a file descriptor, not argv
else code="$(post)"; fi
unset header
echo "test POST: HTTP ${code}"
restart_if_running
case "${code}" in 2??) ;; *) exit 1 ;; esac
