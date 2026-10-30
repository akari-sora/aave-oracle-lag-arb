#!/usr/bin/env bash
# Always-on supervisor for the trading bot. deploy/install.sh copies it into the app directory.
#   trader.sh start       start in the background (no-op if already running); restarts the bot if it exits
#   trader.sh ensure      like start, for schedulers: skips quietly if no wallet is set or it was stopped on purpose
#   trader.sh close-only  restart in close-only mode (no new positions, no deposits, only unwind)
#   trader.sh stop        stop (positions stay open)
#   trader.sh status      running or not, mode, last exit, last log lines
#   trader.sh logs        follow the log
#   trader.sh whoami      wallet address and balances on every chain (checks the key is readable)
#   trader.sh check       one-shot health check for schedulers: JSON, exit 0 = nothing changed since last check, 1 = changed
#   trader.sh exit        stop, then close every position and withdraw to the wallet; falls back to close-only if unfinished
# The wallet comes from ${ARB_CONFIG_DIR}/env (mode 600, written by set-wallet.sh) or from the environment:
#   KEY=<private key | mnemonic | op://vault/item/field>   (mnemonic: also MNEMONIC_INDEX or MNEMONIC_PATH)
#   KEY_ENV=<name of another variable holding the key>     KEY_FILE=<path to a file holding the key>
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${ARB_CONFIG_DIR:-${HOME}/.config/aave-oracle-lag-arb}"
ENV_FILE="${CONFIG_DIR}/env"
ALERTS_FILE="${CONFIG_DIR}/alerts.env"   # ALERT_WEBHOOK_URL / ALERT_WEBHOOK_HEADER, written by set-alerts.sh
PID_FILE="${DIR}/trader.pid"
STOP_FILE="${DIR}/trader.stop"
MODE_FILE="${DIR}/trader.mode"
STATUS_FILE="${DIR}/trader-status.json"   # read by `check`: repeated start failures are reported as trader_crashloop
LOG="${DIR}/trader.log"
NODE="${DIR}/node"                     # bundled Node from install.sh, if the system one was too old
[ -x "${NODE}" ] || NODE="$(command -v node)"
export PATH="${DIR}:${HOME}/.local/bin:${PATH}"   # op (1Password CLI) may live in ${DIR}

running() {
  [ -f "${PID_FILE}" ] || return 1
  local pid; pid="$(cat "${PID_FILE}")"
  kill -0 "${pid}" 2>/dev/null && grep -q "trader.sh" "/proc/${pid}/cmdline" 2>/dev/null
}

# returns 1: no wallet configured; 2: KEY_ENV names a variable this environment doesn't have
load_env() {
  if [ -f "${ENV_FILE}" ]; then set -a; . "${ENV_FILE}"; set +a; fi
  if [ -f "${ALERTS_FILE}" ]; then set -a; . "${ALERTS_FILE}"; set +a; fi
  [ -n "${KEY:-}${PRIVATE_KEY:-}${MNEMONIC:-}${KEY_ENV:-}${KEY_FILE:-}" ] || return 1
  if [ -n "${KEY_ENV:-}" ] && [ -z "${!KEY_ENV:-}" ]; then return 2; fi
}

# prints why the wallet can't be read
need_env() {
  local rc=0
  load_env || rc=$?
  case "${rc}" in
    0) return 0 ;;
    2) echo "wallet is set to come from \$${KEY_ENV}, but this environment doesn't have it" ;;
    *) echo "no wallet configured (${ENV_FILE} or environment)" ;;
  esac
  return 1
}

run() { "${NODE}" "${DIR}/aave-oracle-lag-arb.mjs" "$@"; }

# over 20 MB: copy to .1 and truncate. node appends, so it keeps writing at the start (mv would keep it writing to the old file)
rotate_log() {
  if [ -f "${LOG}" ] && [ "$(stat -c %s "${LOG}" 2>/dev/null || stat -f %z "${LOG}")" -gt 20000000 ]; then cp -f "${LOG}" "${LOG}.1" && : >"${LOG}"; fi
}

case "${1:-}" in
  start | ensure)
    if running; then echo "already running (pid $(cat "${PID_FILE}"), $(cat "${MODE_FILE}" 2>/dev/null || echo normal) mode)"; exit 0; fi
    if ! (need_env); then
      [ "$1" = ensure ] && { echo "not starting"; exit 0; }
      echo "set a wallet first: ${DIR}/set-wallet.sh" >&2; exit 1
    fi
    if [ "$1" = ensure ] && [ -f "${STOP_FILE}" ]; then echo "stopped with trader.sh stop; not starting"; exit 0; fi
    rm -f "${STOP_FILE}"
    # ensure keeps the previous mode (after a failed exit it is close-only, and must stay so after a reboot)
    if [ "${CLOSE_ONLY:-}" != 1 ] && [ "$1" = ensure ] && [ "$(cat "${MODE_FILE}" 2>/dev/null)" = "close-only" ]; then export CLOSE_ONLY=1; fi
    if [ "${CLOSE_ONLY:-}" = 1 ]; then echo "close-only" >"${MODE_FILE}"; else echo "normal" >"${MODE_FILE}"; fi
    setsid nohup bash "${DIR}/trader.sh" loop >>"${LOG}" 2>&1 </dev/null &
    sleep 2
    running && echo "started (pid $(cat "${PID_FILE}"), $(cat "${MODE_FILE}") mode), log: ${LOG}" || { echo "did not start, see ${LOG}" >&2; exit 1; }
    ;;
  loop)
    echo $$ >"${PID_FILE}"
    load_env || true
    (while sleep 300; do rotate_log; done) &   # same session, stopped together
    fails=0
    while [ ! -f "${STOP_FILE}" ]; do
      rotate_log
      started=$(date +%s)
      if [ "${CLOSE_ONLY:-}" = 1 ]; then dep=0; else dep=all; fi   # --deposit all: all USDC/USDT in the wallet becomes principal
      echo "=== $(date -Is) starting bot ($(cat "${MODE_FILE}" 2>/dev/null || echo normal) mode)"
      code=0
      run start --yes --deposit "${dep}" || code=$?
      [ -f "${STOP_FILE}" ] && break
      # exiting within 5 minutes counts as a failed start (key unreadable, every RPC down); check reports 3 in a row as trader_crashloop
      if [ $(($(date +%s) - started)) -lt 300 ]; then fails=$((fails + 1)); else fails=0; fi
      printf '{"lastExit":"%s","lastCode":%s,"consecutiveFailures":%s}\n' "$(date -Is)" "${code}" "${fails}" >"${STATUS_FILE}"
      # backoff: 10 s the first time, then 30 s more per failure, at most 5 minutes
      wait_s=$((fails < 1 ? 10 : fails * 30))
      [ "${wait_s}" -gt 300 ] && wait_s=300
      echo "=== $(date -Is) bot exited (code ${code}), restarting in ${wait_s} s"
      sleep "${wait_s}"
    done
    rm -f "${PID_FILE}"
    ;;
  close-only)
    "$0" stop >/dev/null || true
    CLOSE_ONLY=1 "$0" start
    ;;
  stop)
    touch "${STOP_FILE}"
    if running; then
      pid="$(cat "${PID_FILE}")"
      pkill -TERM -s "$(ps -o sid= -p "${pid}" | tr -d ' ')" 2>/dev/null || kill "${pid}"
      sleep 1
      echo "stopped (positions stay open; use trader.sh exit to unwind)"
    else
      echo "was not running"
    fi
    rm -f "${PID_FILE}"
    ;;
  status)
    if running; then echo "running (pid $(cat "${PID_FILE}"), $(cat "${MODE_FILE}" 2>/dev/null || echo normal) mode)"; else echo "not running$([ -f "${STOP_FILE}" ] && echo " (stopped with trader.sh stop)")"; fi
    [ -f "${STATUS_FILE}" ] && echo "last exit: $(cat "${STATUS_FILE}")"
    if [ -f "${LOG}" ]; then tail -n 8 "${LOG}"; fi
    ;;
  logs)
    tail -n 50 -f "${LOG}"
    ;;
  check)
    load_env || true   # RPC and threshold settings; no key needed
    run check --json --state "${DIR}/check-state.json"
    ;;
  whoami)
    need_env >&2 || exit 1
    run whoami --yes
    ;;
  exit)
    "$0" stop || true
    need_env >&2 || exit 1
    if run exit --yes; then
      echo "exit done (bot is stopped; trader.sh start to begin again)"
    else
      echo "exit not finished (reason above). Restarting in close-only mode to keep watching the position; run trader.sh exit again later" >&2
      CLOSE_ONLY=1 "$0" start
      exit 1
    fi
    ;;
  *)
    sed -n '2,14p' "$0"
    exit 1
    ;;
esac
