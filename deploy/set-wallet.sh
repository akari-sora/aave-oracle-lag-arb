#!/usr/bin/env bash
# Save the bot's wallet to ${ARB_CONFIG_DIR}/env (mode 600), then show its address and balances.
#   set-wallet.sh                              prompt (hidden) for a private key, mnemonic or op:// reference
#   set-wallet.sh --from-env VAR               copy the value of $VAR (e.g. a secret an agent platform injected)
#   set-wallet.sh --env-name VAR               store only the name; $VAR must be set whenever the bot starts
#   set-wallet.sh --op op://vault/item/field   1Password; the service account token is prompted (hidden)
#                 [--token-from-env VAR]       ... or copied from $VAR
#   set-wallet.sh --index N | --path "m/44'/60'/…"   mnemonic account; on its own it only changes the account
# The key is never printed or passed as a command-line argument. Other lines in the env file are kept.
# Keystore files don't work here: the bot would ask for the password on every unattended restart.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${ARB_CONFIG_DIR:-${HOME}/.config/aave-oracle-lag-arb}"
ENV_FILE="${CONFIG_DIR}/env"

ask_hidden() { local v; read -r -s -p "$1" v </dev/tty; echo >&2; printf %s "$v"; }
die() { echo "$*" >&2; exit 1; }
valid_name() { [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "not a variable name: $1"; }

source_kind="" from="" ref="" token_env="" index="" path=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from-env) source_kind=from-env; from="${2:?}"; valid_name "${from}"; shift 2 ;;
    --env-name) source_kind=env-name; from="${2:?}"; valid_name "${from}"; shift 2 ;;
    --op) source_kind=op; ref="${2:?}"; [[ "${ref}" == op://* ]] || die "expected op://vault/item/field"; shift 2 ;;
    --token-from-env) token_env="${2:?}"; valid_name "${token_env}"; shift 2 ;;
    --index) index="${2:?}"; [[ "${index}" =~ ^[0-9]+$ ]] || die "--index takes a number"; shift 2 ;;
    --path) path="${2:?}"; [[ "${path}" == "m/44'/60'/"* ]] || die "--path must start with m/44'/60'/"; shift 2 ;;
    -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done
if [ -z "${source_kind}" ] && [ -z "${index}${path}" ]; then source_kind=prompt; fi

lines=()
case "${source_kind}" in
  prompt)
    secret="$(ask_hidden "private key, mnemonic or op:// reference (hidden): ")"
    [ -n "${secret}" ] || die "nothing entered"
    if [[ "${secret}" == op://* ]]; then
      token="$(ask_hidden "1Password service account token (hidden): ")"
      lines+=("$(printf 'OP_SERVICE_ACCOUNT_TOKEN=%q' "${token}")")
    fi
    lines+=("$(printf 'KEY=%q' "${secret}")")
    ;;
  from-env)
    [ -n "${!from:-}" ] || die "\$${from} is empty or not set in this environment"
    lines+=("$(printf 'KEY=%q' "${!from}")")
    ;;
  env-name)
    lines+=("KEY_ENV=${from}")
    ;;
  op)
    if [ -n "${token_env}" ]; then token="${!token_env:-}"; [ -n "${token}" ] || die "\$${token_env} is empty"
    else token="$(ask_hidden "1Password service account token (hidden): ")"; fi
    lines+=("$(printf 'OP_SERVICE_ACCOUNT_TOKEN=%q' "${token}")" "$(printf 'KEY=%q' "${ref}")")
    ;;
esac
[ -n "${index}" ] && lines+=("MNEMONIC_INDEX=${index}")
[ -n "${path}" ] && lines+=("$(printf 'MNEMONIC_PATH=%q' "${path}")")

# replace the wallet lines, keep everything else (tuning variables, RPCs)
if [ -n "${source_kind}" ]; then drop='KEY|PRIVATE_KEY|MNEMONIC|KEY_ENV|KEY_FILE|OP_SERVICE_ACCOUNT_TOKEN|MNEMONIC_INDEX|MNEMONIC_PATH'
else drop='MNEMONIC_INDEX|MNEMONIC_PATH'; fi
mkdir -p "${CONFIG_DIR}" && chmod 700 "${CONFIG_DIR}"
umask 077
tmp="$(mktemp "${CONFIG_DIR}/env.XXXXXX")"
{ [ -f "${ENV_FILE}" ] && grep -v -E "^(export )?(${drop})=" "${ENV_FILE}" || true; printf '%s\n' "${lines[@]}"; } >"${tmp}"
mv -f "${tmp}" "${ENV_FILE}"
unset secret token lines
echo "saved to ${ENV_FILE} (mode 600)"

echo "checking the wallet (no transactions):"
rc=0
out="$("${DIR}/trader.sh" whoami 2>&1)" || rc=$?
printf '%s\n' "${out}"
if [ "${rc}" != 0 ]; then
  if [[ "${out}" == *MNEMONIC_INDEX* ]]; then
    echo
    echo "pick an account from the list: ${DIR}/set-wallet.sh --index <n for MetaMask #n>"
    echo "                          or: ${DIR}/set-wallet.sh --path \"m/44'/60'/<n>'/0/0\" for Ledger Live #n"
  fi
  exit 1
fi
