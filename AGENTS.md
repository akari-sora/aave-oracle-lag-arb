# Notes for coding agents

Running or operating the bot (install, wallet, start, scheduled check, alerts, exit): follow
`skills/aave-oracle-lag-arb/SKILL.md`. This file is for changing the code.

## Layout

| Path | What |
|---|---|
| `src/OracleLagArb.sol` | the contract: flash-swap `open`/`close` on Uniswap V3, flash-loan `openVia`/`closeVia` through an allowlisted aggregator router |
| `test/` | Foundry fork tests against real chains (`ForkBase.sol` shared, `OracleLagArb.t.sol` mainnet, `L2Fork.t.sol` Arbitrum/Base/Optimism) |
| `bot/start.ts` | CLI entry: wallet, deploy, deposit, run, exit, status, watch, check, whoami |
| `bot/core.ts` | chain table, market reads, sending, the per-block decision loop, findings and webhook |
| `bot/keys.ts` | private key / mnemonic / keystore / 1Password / macOS Keychain parsing |
| `bot/OracleLagArb.json` | ABI + bytecode the bot deploys, with a sha256 of `src/` |
| `deploy/` | Linux install, supervisor (`trader.sh`), `set-wallet.sh`, `set-alerts.sh` |
| `skills/aave-oracle-lag-arb/` | the agent skill; `.claude/skills/` and `.agents/skills/` link to it |

## Checks before you call a change done

```bash
forge build && forge test -vv                       # fork tests; RPCs from ETH_RPC_URL, ARB_RPC_URL, BASE_RPC_URL, OP_RPC_URL
cd bot && npm install && npm run typecheck && npm run bundle
bash -n deploy/*.sh
```

- Changed anything in `src/`: run `forge build && node bot/export-artifact.ts`, or `start.ts` refuses to deploy (source hash mismatch).
- Fork tests unfreeze Aave by impersonating the ACL admin; the bot's own rehearsals use anvil forks. Don't point either at a funded key.
- Node 22.18+ runs `bot/*.ts` directly; the deployed bot is the esbuild bundle (`npm run bundle`, target node20).

## Conventions

- User-facing CLI messages and code comments are Traditional Chinese; keep new ones consistent with the file you are in.
- Keys never go on a command line, into logs, or into files other than the 600 env file written by `set-wallet.sh`.
- Every on-chain action is simulated first; the contract enforces price limits against the Aave oracle on-chain, so keep
  slippage protection in the contract, not only in the bot.
