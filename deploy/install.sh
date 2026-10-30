#!/usr/bin/env bash
# Build the bot into one file and install it with its supervisor into ${APP_DIR}. Run it on the machine that will trade,
# from a checkout of this repo. Re-run after `git pull` to update; a running bot is restarted.
#   bash deploy/install.sh              Node 20+ from PATH, or a pinned Node 22 downloaded into ${APP_DIR} (Linux x64/arm64)
#   bash deploy/install.sh --with-op    also install the 1Password CLI into ${APP_DIR} (for KEY=op://...)
#   bash deploy/install.sh --bundle-node  always keep the pinned Node in ${APP_DIR}, even if PATH has one
#                                         (for machines whose system Node disappears on reboot)
# Then: ${APP_DIR}/set-wallet.sh, ${APP_DIR}/trader.sh start
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-${HOME}/.local/share/aave-oracle-lag-arb}"
NODE_VER=v22.23.4
OP_VER=2.41.1
WITH_OP=0
BUNDLE_NODE=0
for a in "$@"; do
  case "${a}" in
    --with-op) WITH_OP=1 ;;
    --bundle-node) BUNDLE_NODE=1 ;;
    *) echo "unknown option: ${a}" >&2; exit 1 ;;
  esac
done

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PLAT=linux-x64; OP_ARCH=amd64; NODE_SHA=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce ;;
  Linux-aarch64) PLAT=linux-arm64; OP_ARCH=arm64; NODE_SHA=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b ;;
  *) PLAT="" ;;
esac

mkdir -p "${APP_DIR}"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT

node_major() { "$1" -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0; }

# a Node with npm for building; the app runs on ${APP_DIR}/node if we had to download one (or --bundle-node)
BUILD_NODE="$(command -v node || true)"
SYSTEM_OK=1
if [ -z "${BUILD_NODE}" ] || [ "$(node_major "${BUILD_NODE}")" -lt 20 ]; then SYSTEM_OK=0; fi
HAVE_PINNED=0
if [ -x "${APP_DIR}/node" ] && [ "$("${APP_DIR}/node" --version 2>/dev/null)" = "${NODE_VER}" ]; then HAVE_PINNED=1; fi
if [ "${SYSTEM_OK}" = 0 ] || { [ "${BUNDLE_NODE}" = 1 ] && [ "${HAVE_PINNED}" = 0 ]; }; then
  [ -n "${PLAT}" ] || { echo "need Node 20 or newer on PATH (automatic download only on Linux x64/arm64)" >&2; exit 1; }
  echo "== downloading Node ${NODE_VER} (${PLAT})"
  curl -fsSL -o "${TMP}/node.tar.xz" "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-${PLAT}.tar.xz"
  echo "${NODE_SHA}  ${TMP}/node.tar.xz" | sha256sum -c --quiet
  tar -xJf "${TMP}/node.tar.xz" -C "${TMP}"
  cp -f "${TMP}/node-${NODE_VER}-${PLAT}/bin/node" "${APP_DIR}/node"   # only the binary: the full distribution is thousands of files
  if [ "${SYSTEM_OK}" = 0 ]; then export PATH="${TMP}/node-${NODE_VER}-${PLAT}/bin:${PATH}"; fi   # its npm builds the bundle
fi

echo "== building"
had_modules=0; [ -d "${REPO}/bot/node_modules" ] && had_modules=1
(cd "${REPO}/bot" && npm ci --no-audit --no-fund --loglevel=error && npm run -s bundle)
[ "${had_modules}" = 0 ] && rm -rf "${REPO}/bot/node_modules"   # keep inode use low on small machines

echo "== installing to ${APP_DIR}"
cp -f "${REPO}/bot/dist/aave-oracle-lag-arb.mjs" "${REPO}/bot/OracleLagArb.json" "${APP_DIR}/"
for f in trader.sh set-wallet.sh set-alerts.sh; do cp -f "${REPO}/deploy/${f}" "${APP_DIR}/${f}"; chmod 755 "${APP_DIR}/${f}"; done

if [ "${WITH_OP}" = 1 ]; then
  [ -n "${PLAT}" ] || { echo "--with-op: automatic install only on Linux x64/arm64" >&2; exit 1; }
  if [ ! -x "${APP_DIR}/op" ] || [ "$("${APP_DIR}/op" --version)" != "${OP_VER}" ]; then
    echo "== 1Password CLI ${OP_VER}"
    curl -fsSL -o "${TMP}/op.zip" "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VER}/op_linux_${OP_ARCH}_v${OP_VER}.zip"
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extract('op', sys.argv[2])" "${TMP}/op.zip" "${APP_DIR}" && chmod 755 "${APP_DIR}/op"
  fi
fi

"${APP_DIR}/node" --version >/dev/null 2>&1 && echo "node $("${APP_DIR}/node" --version) (bundled)" || echo "node $(node --version) (system)"
if "${APP_DIR}/trader.sh" status | head -1 | grep -q '^running'; then
  "${APP_DIR}/trader.sh" stop >/dev/null && "${APP_DIR}/trader.sh" start
else
  echo
  echo "installed. next:"
  echo "  ${APP_DIR}/set-wallet.sh          # private key, mnemonic or op:// (hidden prompt)"
  echo "  ${APP_DIR}/trader.sh start        # run 24/7; deposits the wallet's USDC/USDT as principal"
fi
