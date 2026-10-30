# aave-oracle-lag-arb

When ETH on Uniswap trades well above Aave's Chainlink oracle, borrow WETH from Aave at the oracle price, sell it on the DEX, and buy it back once the gap closes.

English · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Canonical repo, issues and releases: https://gitlab.com/aa22396584/aave-oracle-lag-arb

## What it does

- A Solidity contract, `OracleLagArb`, turns "deposit stablecoins, borrow WETH at the oracle price, sell it on Uniswap, deposit again" into a single flash-swap transaction, with the minimum sale price checked against the oracle on-chain.
- A TypeScript bot watches Ethereum, Arbitrum, Base and Optimism every block. It opens only when the premium holds, buys back when it is gone, and deleverages on its own when the health factor drops.
- A Linux supervisor and setup scripts run it around the clock, with a health check and webhook alerts.
- An agent skill lets Claude Code, Codex, Hermes Agent, Grok Bot or any other agent install and watch it for you.

**Risk: this is a leveraged short-ETH position, not risk-free arbitrage. If ETH rises far enough, the position is liquidated. Aave can freeze markets at any time. Read the [disclaimer](DISCLAIMER.md) before using it.**

![Rehearsal on an Ethereum mainnet fork](docs/demo.gif)

*Rehearsal on a local anvil fork of Ethereum mainnet with the current code: Aave unfreezes, ETH on Uniswap is pushed 10% above the oracle, the bot opens, prices converge, it closes and exits: 100,000 → 116,484 USDC. The events are simulated and time is compressed; it is not a real trade.*

CLI messages are Traditional Chinese by default; set `BOT_LANG=en` for English. Code comments are Traditional Chinese.

## Background

On 2026-10-29 a Binance hot wallet was drained and Binance paused withdrawals. ETH on the exchange couldn't get out, and for a while ETH on Uniswap traded 10%–30% above the price everywhere else.
Aave prices ETH with a Chainlink oracle, which follows exchange prices, so Aave kept lending ETH at the cheap price.
The manual play at the time was:

1. Deposit stablecoins on Aave
2. Borrow ETH at the oracle's low price
3. Sell it on Uniswap at the high price, for stablecoins
4. Deposit those stablecoins on Aave and go back to step 2, over and over
5. When the Uniswap price falls back, buy ETH and repay all the debt

The most profitable address sold 12,289 ETH at about $2,580 and bought back 12,314 ETH at about $2,297, making about $3.47M
([0xNaiXi](https://x.com/0xNaiXi/status/2115967318274789609), reported by [Chaincatcher](https://www.chaincatcher.com/en/article/2300192)).
For what others actually did, see [How others did it](#how-others-did-it).

## How it works

![How it works](docs/diagram.png)

`src/OracleLagArb.sol` uses a Uniswap V3 flash swap to compress steps 2 to 4 above into **one transaction**:

```
open(pool, minEdgeBps, targetHf, maxWethIn)
  Uniswap sends stablecoins to the contract ──► contract deposits them on Aave ──► borrows WETH at the oracle price ──► pays WETH back to Uniswap

close(pool, maxPremiumBps, maxWethOut)
  Uniswap sends WETH to the contract ──► contract repays its WETH debt on Aave ──► withdraws stablecoins ──► pays them back to Uniswap
```

- **Where selling stops**: the sale sets Uniswap's `sqrtPriceLimitX96` at "oracle price × (1 + minEdgeBps)".
  The swap stops when the Uniswap price is pushed down to that line, so every WETH sells at least `minEdgeBps` above the oracle.
  If someone else is competing at the same time, the transaction sells less; it never sells at a worse price.
- **How much to sell**: set by `targetHf`, the health factor after the sale. With only stablecoin collateral and only WETH debt:

  ```
  HF = (C·lt + V·(1+edge)·ltS) / (D + V) ≥ H   ⇒   V ≤ (C·lt − H·D) / (H − (1+edge)·ltS)
  ```

  C and D are the existing collateral and debt, V is the value of WETH borrowed this time (at the oracle price), lt and ltS are liquidation thresholds.
  The formula assumes every coin sells exactly at the price limit (the worst case). Real fills are better, so the health factor after opening ends up above `targetHf`
  (set to 1.3 in the tests, it came out at 1.37). The bot adds more in the next block until HF is back near the target.
- **Buying back**: `close` buys only while the Uniswap price is ≤ oracle × (1 + maxPremiumBps) and stops above that. For a large position
  the buyback itself pushes the price up, so it may take several transactions.
- **The position belongs to the contract** (the Aave user is the contract address), and only the deployer (owner) can operate it.
  The Uniswap callback accepts only the pool the contract is currently swapping with, and pool addresses are checked against the Uniswap factory.
- The stablecoin follows the pool: open in a WETH/USDC pool and the collateral is USDC; open in a WETH/USDT pool and it is USDT.
  `close` needs a pool with the same stablecoin, because it withdraws that stablecoin from Aave to pay Uniswap.
- Each chain gets its own contract and its own principal. The bot watches all chains at once.

**Aggregator path** (`openVia` / `closeVia`): when a single Uniswap pool can't absorb the size, the bot asks KyberSwap for the best fill, which can sell across Uniswap V3/V4,
Aerodrome/Velodrome, Curve and market-maker quotes. To open, it borrows WETH with an Aave flash loan in mode 2 (no repayment; it becomes variable-rate debt at the end, with no fee),
and the aggregator swaps it to stablecoins that go back into Aave. To close, a flash loan of WETH repays the debt first, then stablecoins go through the aggregator back to WETH to repay the flash loan (0.05% fee).
The safeguards are as strict as the direct flash swap:
- The flash-loan callback only accepts calls that come from Aave, were started by the contract itself, and are in progress. If someone else takes a flash loan naming this contract as receiver, the whole transaction fails.
- The owner must allowlist the aggregator router (`setRouter`; `node start.ts` adds KyberSwap automatically).
- Each approval covers only the amount being sold in that transaction and is reset to zero afterwards.
- The fill is checked on-chain against the oracle: an open must receive at least "WETH × oracle price × (1 + minEdge)" in stablecoins, and a close must pay no more than "(WETH + fee) × oracle price × (1 + maxPremium)".
  The contract measures its own balance changes and does not trust the numbers the aggregator returns.

## When it makes or loses money

The position is **stablecoin collateral against WETH debt, which is a short on ETH**. It is not risk-free arbitrage.

| How the gap closes | Result |
|---|---|
| Uniswap falls back to the oracle price (the exchange resumes withdrawals and cheap ETH flows out) | You keep the spread. Test: 100k USDC principal, 10% premium, mainnet makes **+14,593 USDC** |
| The oracle rises to meet Uniswap | You buy back at the same price you sold: no profit, plus two rounds of swap fees. Test: **−166 USDC** |
| ETH rallies across the board | Loss; a big enough rally gets you liquidated |

- **Liquidation line**: the health factor is inversely proportional to the oracle's ETH price. If HF = h after opening, the oracle only has to rise by (h − 1) for liquidation.
  HF 1.37 means the position survives a 37% rise in the oracle price.
- **Hedging**: to make this a true arbitrage, buy the same amount of ETH on the exchange (where ETH is cheaper) or open a perpetual long.
  This project has no exchange integration.
- **Aave freezes markets**: during this event Aave's Guardian froze V3 on 16 chains and V4 on 4 chains at once,
  so running on several chains does not spread freeze risk. While frozen, `open` fails, but repaying and withdrawing still work.
  On 2026-10-30, WETH, USDC and USDT on mainnet, Arbitrum, Base and Optimism were all still frozen with LTV = 0.
- **Stablecoins may be stuck after a freeze**: depositors pulled out after the freeze, mainnet V3 USDC utilization reached 97.8%, and some markets hit 100%.
  Withdrawals then have to wait for someone to repay. Keep some ETH or stablecoins outside the protocol.
- **Borrow rate**: when everyone is borrowing WETH, utilization jumps into the slope2 range and the variable rate can get very high. The longer you hold, the more it costs.
- **Being front-run**: `open` is a public arbitrage transaction; on mainnet it goes through Flashbots Protect by default. The price limit guarantees the worst fill price, not that it fills.

## What's supported

| | Supported | Not supported |
|---|---|---|
| Chains | Ethereum mainnet, Arbitrum, Base, Optimism | Other chains (the contract deploys, but the bot has no address table); non-EVM chains |
| Lending | Aave V3 | Aave V4, Compound, Morpho, Spark (different interfaces or untested) |
| Exchanges | Uniswap V3 (direct flash swap from the contract); through the KyberSwap aggregator: Uniswap V3/V4, Aerodrome/Velodrome, Curve, market-maker quotes; premium detection on Aerodrome/Velodrome Slipstream (Base, OP) | Premium detection on Uniswap V4 and Curve; CEXs |
| Tokens | Borrow WETH against USDC/USDT collateral (Aave has no USDT on Base) | Other tokens; the reverse direction (DEX cheaper than the oracle) |

## Files

```
src/OracleLagArb.sol                  the contract
src/interfaces/External.sol           Aave V3 / Uniswap V3 interfaces (only what is used)
test/ForkBase.sol                     fork tests shared by all chains
test/OracleLagArb.t.sol               mainnet fork tests (shared + mainnet-only)
test/L2Fork.t.sol                     Arbitrum, Base, Optimism fork tests
script/Deploy.s.sol                   deploy with Foundry
bot/start.ts                          entry point: wallet, deploy, deposit, auto-trade, exit, health check for schedulers and agents
bot/core.ts                           chain config, market reads, sending, bot logic, alerts
bot/keys.ts                           private key, mnemonic, keystore, 1Password, macOS Keychain
bot/OracleLagArb.json                 ABI + bytecode for deployment (exported from forge build, with the source sha256)
bot/export-artifact.ts                re-exports that file after a contract change
deploy/install.sh                     Linux: bundles bot/ into bot/dist/aave-oracle-lag-arb.mjs and installs it with the supervisor
deploy/trader.sh                      supervisor: run in the background, restart on exit, status, health check, exit
deploy/set-wallet.sh                  stores the wallet (mode 600 file) and checks it can be read
deploy/set-alerts.sh                  stores the alert webhook and sends a test POST
skills/aave-oracle-lag-arb/SKILL.md   agent skill: install, configure, scheduled check, exit
AGENTS.md                             notes for coding agents changing the code
integrations/grok-bot.md              running it on Grok Bot
```

## Running from source

This section runs the bot straight from the checkout, on any OS. To run it 24/7 on Linux, see [Always-on deployment (Linux)](#always-on-deployment-linux).

You need Node 22.18+ (or 23.6+), which runs `.ts` files directly. Install dependencies once:

```bash
cd bot && npm install
```

### One command to start

```bash
cd bot
caffeinate -i node start.ts      # caffeinate keeps a Mac awake; elsewhere just run node start.ts
```

It goes through these steps and asks before each one:

1. Asks for a wallet (see the next section)
2. On each chain where the wallet has ETH for gas and some USDC/USDT, deploys the contract (about 0.003 ETH on mainnet, next to nothing on L2s)
   and asks how much principal to deposit. If Aave is frozen and won't take deposits, it approves now and the bot deposits in the block Aave unfreezes
3. Chains with no ETH or no stablecoins are only monitored and send alerts. If a contract already exists there, the position is still watched (for example, if gas runs out while a position is open, a low HF is still reported); it just doesn't send transactions
4. Starts trading on its own, deciding once per block on each chain (rules below). Ctrl+C stops it and leaves positions open

Contract addresses are stored in `bot/state.json` (addresses only, no keys).

To skip the prompts:

```bash
PRIVATE_KEY=0x... node start.ts --yes --deposit 100000     # deposit 100000 on each chain; --deposit all / 0; --token USDT
node start.ts --chains mainnet,arbitrum                    # only these chains
```

### Giving it a wallet

Paste any of these when asked (input is hidden and never saved), or put it in the environment as `PRIVATE_KEY`, `MNEMONIC` or `KEY`.
`KEY_ENV=<name of another variable>` and `KEY_FILE=<path to a file holding the key>` also work.

| What to paste | Notes |
|---|---|
| Private key | With or without `0x`, any case, quotes and line breaks are fine |
| Mnemonic | 12–24 words; line breaks, commas, numbering (`1.` `2)` `3、`) and any case are fine. English, Simplified and Traditional Chinese, Japanese, Korean, Spanish, French, Italian, Czech and Portuguese word lists; Chinese works without spaces. Typos get the closest word suggested, and a bad checksum is rejected |
| Keystore file path | JSON from a MetaMask export, geth or `cast wallet import`; it then asks for the password |
| `foundry:<name>` | Reads `~/.foundry/keystores/<name>`; `--account <name>` does the same |
| `op://vault/item/field` | Read with the 1Password CLI (`op read`) |

With a mnemonic, it lists the usual accounts for it (MetaMask #0–#4, Ledger Live #1–#2) with their ETH, stablecoins and contracts on each chain,
and picks the first one that holds funds. To choose one, set `MNEMONIC_INDEX=2` or `MNEMONIC_PATH="m/44'/60'/0'/0/7"`.

On a Mac, after the first entry it asks whether to remember the wallet in the macOS Keychain (default no). If you say yes, next time you just press Enter.
It stores the private key of the chosen account, not the whole mnemonic. `node start.ts forget` deletes it.

### Exiting

```bash
node start.ts exit
```

On each chain: keeps buying back WETH until the debt is zero, withdraws all collateral to the wallet, and sweeps leftover dust from the contract.
- The contract only buys as much as that stablecoin can pay for, so a position split across USDC and USDT closes in several rounds, alternating stablecoins. Pools that can only fill a tiny amount are skipped at first.
- It works while Aave is frozen: a freeze blocks new deposits and borrows, not repayments or withdrawals.
- If it can't close, it says why: every pool is more than `EXIT_MAX_PREMIUM_BPS` above the oracle (default 3%; run it later or raise the limit),
  or Aave's stablecoin cash is fully borrowed and the collateral can't be withdrawn (**send stablecoins straight to the contract address**; the contract uses them first when paying). Other chains carry on.

You can exit from a different machine: without `state.json`, the bot scans the contracts this wallet deployed in its last 300 transactions and finds them again.
Or name them directly: `ARB_ADDRESS_MAINNET=0x… node start.ts exit` (and `ARB_ADDRESS_ARBITRUM`, `ARB_ADDRESS_BASE`, `ARB_ADDRESS_OPTIMISM`).

### Other commands

```bash
node start.ts status     # the contract's position on each chain (no key needed)
node start.ts watch      # watch premiums only (no key needed)
node start.ts check      # run once and exit, for schedulers and agents (see Alerts)
node start.ts whoami     # wallet address and balances on every chain (checks the key is readable; sends nothing)
node start.ts forget     # delete the wallet remembered in the Keychain
```

```
04:35:45 [Arbitrum] #519575059 預言機 $2239.41 | USDC 0.01% +0.06% | USDC 0.05% +0.04% | ... | Aave 凍結中
04:35:45 [Ethereum] #26303215 預言機 $2232.50 | USDT 0.01% +0.43% | USDT 0.05% +0.42% | ... | Aave 凍結中
```

(預言機 = oracle, Aave 凍結中 = Aave frozen.) When nothing is happening, each chain prints one line every `LOG_MS` (30 seconds). It prints every block when the premium is above half the open threshold, a position is open, or a transaction is pending.

### How the bot decides

Each chain decides on its own, every block, going down this list; the first rule that applies wins. Every transaction is simulated first (eth_call) and not sent if the simulation fails.
Each chain has at most one transaction pending at a time.

1. Previous transaction not mined yet → wait. It is released once mined, once its nonce is used, or when Flashbots returns FAILED / CANCELLED / UNKNOWN.
   The fallback is 10 blocks on mainnet (about the same time on L2s)
2. Principal waiting to be deposited, and Aave now accepts it (not frozen, supply cap has room) → deposit
3. Debt and HF < `EMERGENCY_HF` → whether or not the premium is still there, **buy back only enough to bring HF back to `EMERGENCY_TARGET_HF`** (plus 5%) instead of closing everything.
   It closes everything only when buying back at that price would lower HF further. If no pool can fill, it tells you to send stablecoins to the contract or repay directly with WETH via `repayFromOwner`
4. A usable pool's premium is ≥ `OPEN_PREMIUM_BPS` and has been for `CONFIRM_SECONDS` →
   **ask the aggregator first**: size is the smaller of what the health factor allows (estimated at half the premium) and the per-transaction caps below. If the quote is below the oracle floor, halve the size, up to 3 times;
   send `openVia` once the simulation passes. Only if the aggregator doesn't answer or every quote falls short does it try single Uniswap pools with `open`, highest premium first, stopping after one is sent.
   While the aggregator is available, premiums shown on Aerodrome/Velodrome pools count too.
   Usable = Aave's WETH isn't frozen, this stablecoin can be deposited (not frozen, LTV > 0, supply cap has room), and the pool holds at least `MIN_POOL_WETH` WETH (dead pools don't count).
   Each transaction sells at most the smallest of `MAX_WETH_PER_TX`, 95% of the WETH Aave can still lend, and 95% of how much of this stablecoin can still be deposited (in WETH terms).
   Size is first estimated at half the premium (so the first transaction opens in full); if the health factor falls short, the contract reverts and the bot falls back to the most conservative estimate.
   While a usable pool still shows the premium, the position is held, not closed. When only dead pools or pools it can't deposit into show a premium, go on to step 5
5. Debt and some pool's premium is ≤ `CLOSE_PREMIUM_BPS` → buy back, starting with the pool where WETH is cheapest and the contract holds enough of the matching stablecoin.
   If no single pool can close (for example, all are pushed to the price limit, `NoEdge`), switch to the aggregator with `closeVia`. Emergency deleveraging and `exit` do the same: if pools fail, use the aggregator

With `CLOSE_ONLY=1` it only does 1, 3 and 5: no deposits, no new positions, just unwinding.

### Before you use it for real

- **The bot has to stay on.** In this event the top trader got in 24 minutes after it started, and the useful window was about an hour. A sleeping laptop misses it.
  On a Mac use `caffeinate -i`, or run it on an always-on Linux machine under the supervisor (next section).
- Right now (2026-10-30) Aave is frozen. You can run `node start.ts` already: it deploys, approves the principal and waits; after the unfreeze the bot deposits on its own.
  Once the principal is in Aave it also earns supply interest.
- On mainnet, transactions go through Flashbots Protect by default (`SEND_RPC_URL_MAINNET`): no front-running or sandwiching, and a failing transaction never lands and costs no gas;
  but it may take several blocks to land, or never land. On L2s, transactions go straight to the chain's RPC. Set `PRIORITY_FEE_GWEI` to compete on speed.
- Public RPCs sometimes rate-limit. Each chain has two public RPCs by default and switches to the second when the first fails. If you have your own (Alchemy, Infura…), put them in `RPC_URLS_<CHAIN>` (comma-separated, tried in order).
- Chains that can't be reached at startup, or whose setup isn't finished, are retried every minute in unattended mode (`--yes`) and picked up once they work. One chain failing doesn't affect the others.

## Always-on deployment (Linux)

On the machine that will trade:

```bash
git clone https://gitlab.com/aa22396584/aave-oracle-lag-arb.git && cd aave-oracle-lag-arb
bash deploy/install.sh            # --with-op adds the 1Password CLI
~/.local/share/aave-oracle-lag-arb/set-wallet.sh
~/.local/share/aave-oracle-lag-arb/trader.sh start
```

To set up a remote server from a laptop (replace `host`; `-t` lets `set-wallet.sh` show its hidden prompt):

```bash
ssh -t host 'git clone https://gitlab.com/aa22396584/aave-oracle-lag-arb.git && cd aave-oracle-lag-arb && bash deploy/install.sh && ~/.local/share/aave-oracle-lag-arb/set-wallet.sh'
ssh host ~/.local/share/aave-oracle-lag-arb/trader.sh start     # keeps running after ssh disconnects
```

### What install.sh does

- Uses Node 20+ from `PATH`. If there is none, or it is older, it downloads a pinned Node 22 build (Linux x64/arm64 only), checks its sha256, and copies just the `node` binary into `APP_DIR`.
- Runs `npm ci`, then bundles `bot/` with esbuild into one file, `bot/dist/aave-oracle-lag-arb.mjs`, which runs without `node_modules`. If `bot/node_modules` didn't exist before, it is deleted afterwards (small machines run short of inodes).
- Copies the bundle, `bot/OracleLagArb.json`, `trader.sh`, `set-wallet.sh` and `set-alerts.sh` into `APP_DIR`.
- `--with-op` also installs the 1Password CLI into `APP_DIR` (Linux x64/arm64 only; needs `python3` to unzip).
- `--bundle-node` always keeps the pinned Node in `APP_DIR`, for machines whose system Node disappears on reboot (for example a Grok Bot computer).
- Restarts the bot if it is running; otherwise prints the next steps.

You need `bash`, `git` and `curl`; for the Node download also `sha256sum` and a `tar` that handles `.tar.xz`.

| | Default | What's in it |
|---|---|---|
| `APP_DIR` | `~/.local/share/aave-oracle-lag-arb` | the bundled bot, `trader.sh` and the other scripts, the downloaded `node` / `op`, the log `trader.log`, `state.json` (contract addresses), heartbeats and check state |
| `ARB_CONFIG_DIR` | `~/.config/aave-oracle-lag-arb` | `env` (wallet and other settings) and `alerts.env` (webhook). Files are mode 600, the directory 700 |

`APP_DIR` is only read at install time (`APP_DIR=/opt/arb bash deploy/install.sh`; use the same value when you update). The installed scripts know their own directory.
If you change `ARB_CONFIG_DIR`, set the same value for every `set-wallet.sh`, `set-alerts.sh` and `trader.sh` call, including the scheduler's.

### Setting the wallet (set-wallet.sh)

```bash
APP=~/.local/share/aave-oracle-lag-arb
$APP/set-wallet.sh                                    # hidden prompt: private key, mnemonic or op:// (op:// also asks for the service account token)
$APP/set-wallet.sh --from-env AAVE_BOT_KEY            # copy the value of this variable (e.g. a secret an agent platform injected)
$APP/set-wallet.sh --env-name AAVE_BOT_KEY            # store only the name; the variable must be set whenever the bot starts
$APP/set-wallet.sh --op op://vault/item/field         # 1Password; the token is asked for in a hidden prompt
$APP/set-wallet.sh --op op://vault/item/field --token-from-env OP_TOKEN    # ...or taken from a variable
$APP/set-wallet.sh --index 2                          # mnemonic: use MetaMask #2
$APP/set-wallet.sh --path "m/44'/60'/1'/0/0"          # mnemonic: use Ledger Live #1
```

| Mode | What the env file holds |
|---|---|
| Prompt, `--from-env` | `KEY=<value>` (the private key or mnemonic itself) |
| `--env-name` | `KEY_ENV=<name>`, the name only. If the scheduler's environment lacks the variable after a reboot, `ensure` says "this environment doesn't have it" and doesn't start |
| `--op`, or `op://` at the prompt | `OP_SERVICE_ACCOUNT_TOKEN` and `KEY=op://…`. Use a vault that holds only this key, and give the token read access to that vault only |
| `--index`, `--path` | `MNEMONIC_INDEX` / `MNEMONIC_PATH`. On their own they only change the account and keep the key; they also combine with the modes above |

- The key is never printed or passed as a command-line argument. Other lines in the env file (tuning variables, RPCs) are kept; only the wallet lines are replaced.
- It finishes by running `trader.sh whoami` (no transactions), which prints the address and the balances on every chain.
- If a mnemonic has no account chosen, `whoami` fails and lists the accounts; pick one with `--index` or `--path` as it suggests. Unattended mode never guesses the account: a wrong guess could deposit another wallet's money, or switch addresses on a restart.
- A keystore file asks for its password on every start, and the supervisor runs in the background with nobody to type it. For always-on use, give a private key, a mnemonic or 1Password.
- You can skip the env file: `trader.sh` also reads `KEY`, `PRIVATE_KEY`, `MNEMONIC`, `KEY_ENV` and `KEY_FILE=<path to a file holding the key>` from its environment.

### Controlling it (trader.sh)

```bash
$APP/trader.sh start        # run in the background; does nothing if already running
$APP/trader.sh status       # running or not, mode, last exit, last log lines
$APP/trader.sh logs         # follow the log
$APP/trader.sh whoami       # wallet address and balances on every chain
$APP/trader.sh stop         # stop (positions stay open)
$APP/trader.sh close-only   # unwind only: no new positions, no deposits
$APP/trader.sh exit         # stop, close every position, withdraw to the wallet
$APP/trader.sh ensure       # for schedulers: start it if it isn't running
$APP/trader.sh check        # for schedulers: health check as JSON
```

| Command | What it does |
|---|---|
| `start` | Runs in the background and survives closing the terminal or ssh session; restarts the bot whenever it exits |
| `ensure` | Like `start`, but quietly skips if no wallet is set or it was stopped with `stop`; keeps the previous mode |
| `close-only` | Restarts in close-only mode |
| `stop` | Stops; positions stay open. `ensure` won't bring it back, only `start` will |
| `status` | Running or not, mode, time and code of the last exit, last 8 log lines |
| `logs` | Follows the log |
| `whoami` | Wallet address and balances on every chain (checks the key is readable) |
| `check` | One-shot health check printed as JSON. Exit 0 = nothing changed since the last check, 1 = something changed, other = error. No key needed (see [Alerts](#alerts)) |
| `exit` | Stops, then closes every position and withdraws to the wallet. If it can't finish, it restarts in close-only mode |

### What the supervisor does

- Starts the bot with `start --yes --deposit all`: **all USDC/USDT in the wallet is deposited as principal** on every chain where Aave accepts it; ETH stays in the wallet for gas. Close-only mode uses `--deposit 0`.
- Restarts the bot when it exits. After a run of 5 minutes or more, it restarts in 10 s. Exiting within 5 minutes of starting counts as a failure; after n failures in a row it waits n × 30 s, at most 5 minutes, and never gives up.
  After 3 failures in a row, the latest within 15 minutes, `check` reports `trader_crashloop`.
- Once stopped with `stop`, `ensure` leaves it stopped. Nothing restarts the bot after a reboot until your scheduler runs `ensure` (see [Run it with an AI agent](#run-it-with-an-ai-agent)).
- If `exit` can't finish (prices too high, stablecoins can't be withdrawn), it restarts in close-only mode and keeps looking after the position; run `exit` again later.
  `ensure` keeps close-only mode, including after a reboot.
- The log is `APP_DIR/trader.log`. Over 20 MB it is copied to `trader.log.1` and truncated (checked before each start and every 5 minutes). If the heartbeat file can't be written (a full disk, say), trading carries on.
- Contract addresses live in `APP_DIR/state.json`. If that directory is lost, re-run `install.sh`: contract addresses are found again from the wallet's transaction history, and state files are rebuilt.

### Updating

```bash
cd aave-oracle-lag-arb && git pull && bash deploy/install.sh     # restarts the bot if it is running
```

The installer never touches `ARB_CONFIG_DIR`, so the wallet and webhook settings stay.

### Keeping the key safe

- **On any machine shared by several bots or agents (including an agent platform's computer), the others can read the key once the bot runs.**
  Whichever way you give it the wallet, the key ends up in the bot's process on that machine. Use a dedicated wallet that holds only this strategy's money.
- The env files are mode 600 and the directory 700. None of the three scripts prints the key or puts it on a command line.

### macOS

The supervisor is Linux-only (it uses `setsid` and `/proc`). On a Mac, run the bot from source in a terminal:

```bash
cd bot && npm install && caffeinate -i node start.ts
```

### What has been verified

Verified on 2026-10-30 on a cloud Linux x64 VM with an empty test wallet:
- `install.sh` with a system Node 20, and with the pinned Node 22 download
- `set-wallet.sh` from an environment variable: a mnemonic → account list → `--index`; a private key; `--env-name` with and without the variable set
- `set-alerts.sh` test POST: HTTP 200 succeeds, a 404 fails
- `trader.sh` `start`, `status`, `stop` and `ensure`

Not verified yet: the 1Password path with a real token; the Grok Bot and Hermes Agent flows end to end.

## Run it with an AI agent

The bot doesn't depend on any particular agent. Everything goes through the scripts in `deploy/`, so any agent that can run a shell can operate it.

| File | Purpose |
|---|---|
| `skills/aave-oracle-lag-arb/SKILL.md` | The skill ([agentskills.io](https://agentskills.io) format): install, set the wallet, start, scheduled check, read findings, exit |
| `.claude/skills/` | Links to that skill; Claude Code picks it up when you open the repo |
| `.agents/skills/` | Links to that skill, for Codex |
| `AGENTS.md` | For coding agents changing the repo (Codex, Cursor; Claude Code reads it through CLAUDE.md) |

The skill tells the agent to take the key through the platform's masked secret input as an environment variable and run `set-wallet.sh --from-env`, never through ordinary chat;
to show the address and balances and ask once before starting; and to run `stop`, `close-only` or `exit` only when you ask.

### Claude Code, Codex, Cursor

Open the repo on the machine that will trade and say "set up the oracle-lag bot on this machine".

To use the skill from any directory, copy it out:

```bash
cp -r skills/aave-oracle-lag-arb ~/.claude/skills/    # Claude Code
cp -r skills/aave-oracle-lag-arb ~/.agents/skills/    # Codex
```

### Hermes Agent

```bash
cp -r skills/aave-oracle-lag-arb ~/.hermes/skills/
hermes skills list | grep aave-oracle-lag-arb   # picked up? in an open session, /reload-skills refreshes slash commands
```

Hermes can also install skills from a GitHub path with `hermes skills install <owner>/<repo>/<path>`; the mirror is
`akari-sora/aave-oracle-lag-arb`, skill path `skills/aave-oracle-lag-arb` (not tested).
Then ask Hermes to install the bot and schedule `trader.sh ensure` followed by `trader.sh check` every 6 hours.

### Grok Bot

Fastest: open the template [https://x.ai/bot/4OryWRBkWbghpXyZytSSm](https://x.ai/bot/4OryWRBkWbghpXyZytSSm) and choose **Add to Grok Bot**. You get your own copy of the bot, so the wallet secret, routines and computer are yours alone.
Then say "set up" and "set wallet". Details and the persona (to build it by hand) are in [integrations/grok-bot.md](integrations/grok-bot.md).
It installs the trader on the Grok Bot computer, takes the key through a masked secret card,
and a routine runs `ensure` and `check` every 6 hours. A webhook-triggered routine, connected with `set-alerts.sh`, can receive instant alerts.

Every bot on one Grok account shares that computer ([xAI docs](https://docs.x.ai/grok-bot/security-faq): "Treat a login or file on the computer as available to every Bot that user runs").

### Any other agent, or plain cron

A scheduler only needs to run these two, in order. Every 6 hours is enough; the bot itself reacts every block.

```bash
APP=~/.local/share/aave-oracle-lag-arb
$APP/trader.sh ensure     # start it if it isn't running; skips if no wallet is set or it was stopped on purpose
$APP/trader.sh check      # prints one JSON object
```

If `ensure` prints `started`, the bot had died or the machine rebooted; that's worth a message.

| `check` exit code | Meaning | What to do |
|---|---|---|
| 0 | Nothing changed since the last check | Stay quiet |
| 1 | Something new appeared or something resolved | Summarize `new` and `resolved` in a sentence or two |
| other | Error | Report the first lines of the error once, not every time |

```json
{"changed": true, "findings": [{"level": "warning", "code": "premium_open:base", "kind": "condition", "message": "…"}], "new": ["premium_open:base"], "resolved": []}
```

On the first run, it counts as changed only if there is a warning or critical finding. The previous run's codes are kept in `APP_DIR/check-state.json`. The codes are explained under [Alerts](#alerts).
For instant notifications, point `set-alerts.sh` at a webhook (the payload is also under [Alerts](#alerts)).

With plain cron:

```
@reboot      $HOME/.local/share/aave-oracle-lag-arb/trader.sh ensure
0 */6 * * *  $HOME/.local/share/aave-oracle-lag-arb/trader.sh ensure
```

Cron doesn't send messages by itself: pair it with a webhook, or wrap `trader.sh check` in your own script that notifies you on exit code 1.
Cron starts with a short `PATH`; if `node` isn't in `/usr/bin` (installed with nvm, for example), set `PATH=` at the top of the crontab.

## Alerts

`check` and the webhook share one list of findings. Each code ends with `:<chain>` (for example `premium_open:arbitrum`), so the same problem on different chains counts as separate findings.

| code | level | When |
|---|---|---|
| `premium_open:<chain>` | warning | The most expensive pool's premium is ≥ `OPEN_PREMIUM_BPS` (if Aave is frozen, the message says it can't borrow). It ends only when the premium drops below the threshold − 1% (half the threshold if the threshold is under 2%) |
| `hf_low:<chain>` | critical | Debt and HF < `EMERGENCY_HF` |
| `bot_not_running:<chain>` | warning | There is an opportunity or a position, but the bot for this chain on this machine hasn't written a heartbeat in the last minute (`heartbeat-<chain>.json` next to the bot: `bot/` from source, `APP_DIR` under the supervisor) |
| `action_failing:<chain>` | warning | `ACTION_FAIL_ALERT` (5) actions in a row didn't succeed: simulation failed, the transaction failed, or it never landed. "At the price limit, waiting" doesn't count |
| `gas_low:<chain>` | warning | A position is open and the wallet has less than 0.02 ETH on mainnet / 0.002 on L2s (emergency deleveraging couldn't be sent) |
| `trader_crashloop` | critical | The bot under `trader.sh` exited within 5 minutes of starting 3 times in a row, the latest within 15 minutes (for example, 1Password can't read the key) |
| `rpc_error:<chain>` | warning | Couldn't read this chain (only from `check`) |
| `position_open:<chain>` | info | A position is open |
| `aave_frozen:<chain>` | info | Can't borrow on this chain: Aave V3 WETH is frozen, or no stablecoin can be collateral (frozen or LTV 0) |

### Scheduled check

`node start.ts check --json` prints the list of findings and exits 1 if any is a warning or critical. Messages are in Traditional Chinese:

```json
[{"level": "warning", "code": "premium_open:mainnet", "kind": "condition", "message": "Ethereum Uniswap USDC 0.05% 的 ETH 比 Aave 預言機貴 +9.73%"}]
```

**Changes only**: `node start.ts check --json --state <file>` remembers the previous run's codes and exits 1 only when something appeared or disappeared, printing
`{"changed", "findings", "new", "resolved"}`. On the first run it counts as changed only if there is a warning or critical finding. Use this for schedules: no change, no notification.
`trader.sh check` runs exactly this, with the state file at `APP_DIR/check-state.json`.

### Webhook

While `watch` or the bot is running, with `ALERT_WEBHOOK_URL` set (and `ALERT_WEBHOOK_HEADER`, e.g. `Authorization: Bearer …`),
it POSTs once whenever a chain's list changes (the first round only if there is a warning or critical finding):

```json
{"source": "aave-u-eth", "host": "…", "chain": "base", "time": "…", "block": "53272934", "findings": [...], "new": ["premium_open:base"], "resolved": []}
```

`host` is the machine's hostname. `aave_frozen:<chain>` showing up in `resolved` means that chain can be borrowed against again (WETH unfrozen and a stablecoin with LTV above 0). The bot doesn't wait for the webhook's response (10 s timeout), so it never slows down trading decisions.

### Setting the webhook (set-alerts.sh)

Under the supervisor, the URL and header are stored in `ARB_CONFIG_DIR/alerts.env` (mode 600); re-running the installer doesn't overwrite them.

```bash
$APP/set-alerts.sh https://example.com/hook                              # hidden prompt for the auth header or a bare token
$APP/set-alerts.sh https://example.com/hook --header-from-env ALERT_KEY  # take it from a variable (e.g. a secret an agent platform injected)
$APP/set-alerts.sh https://example.com/hook --no-auth                    # the URL itself carries the secret
$APP/set-alerts.sh --off                                                 # remove the webhook
```

- A bare token becomes `Authorization: Bearer <token>`; anything with a colon is used as the full header line.
- After saving, it sends a test POST in the same shape the bot uses, with no findings:
  `{"source":"aave-u-eth","test":true,"findings":[],"new":[],"resolved":[]}`. It prints the HTTP status and exits 1 on anything other than 2xx (the settings stay saved; fix and run it again, or use `--off`).
- The header reaches curl through a file descriptor, never the command line.
- If the bot is running, it is restarted so the new settings take effect.

## Configuration

Everything has a default. When running from source, copy `bot/.env.example` to `bot/.env`; it is read at startup (variables already in the environment win).
Under the supervisor, add the variables to `ARB_CONFIG_DIR/env` (`set-wallet.sh` leaves them alone), then run `trader.sh stop && trader.sh start`.

| Variable | Default | Notes |
|---|---|---|
| `CHAINS` | `mainnet,arbitrum,base,optimism` | Which chains to run |
| `RPC_URLS_<CHAIN>` | Two public RPCs per chain (see `bot/core.ts`) | For reads and gas estimates; comma-separated, tried in order. `<CHAIN>` is `MAINNET` / `ARBITRUM` / `BASE` / `OPTIMISM`; for a single one use `RPC_URL_<CHAIN>` |
| `SEND_RPC_URL_<CHAIN>` | Mainnet `https://rpc.flashbots.net/fast`; L2s same as `RPC_URL_<CHAIN>` | For sending transactions |
| `PRIORITY_FEE_GWEI` | Estimated | Tip for the block builder |
| `GAS_LIMIT_MULT` | 1.25 | Gas limit = estimate × this (between estimate and inclusion, a flash swap may cross a few more ticks) |
| `MAX_FEE_BASE_MULT` | 2 | maxFeePerGas = base fee × this + tip |
| `OPEN_PREMIUM_BPS` | 300 | Open only at a premium ≥ 3% |
| `CONFIRM_SECONDS` | 15 | The premium must stay above the threshold this many seconds before opening. Filters out jumps caused by one big trade that get arbitraged away in the next block (the waiting message prints every `LOG_MS`) |
| `MIN_EDGE_BPS` | 50 | Stop selling when the premium is down to 0.5% |
| `TARGET_HF` | 1.3 | Minimum health factor after opening. At least 1.05 (below "liquidation threshold ÷ LTV" Aave refuses the borrow); checked at startup |
| `MAX_WETH_PER_TX` | 0 | Most WETH sold per transaction; 0 = limited only by what Aave can lend |
| `MIN_WETH_PER_TX` | 0.5 | Don't open for less than this |
| `CLOSE_PREMIUM_BPS` | 30 | Buy back when the premium is ≤ 0.3% |
| `EMERGENCY_HF` | 1.1 | Below this, deleverage regardless of price |
| `EMERGENCY_TARGET_HF` | Same as `TARGET_HF` | Deleveraging stops once HF is back at this value |
| `MIN_POOL_WETH` | 5 | A pool with less WETH than this counts as dead |
| `CLOSE_ONLY` | — | `1` = only unwind: no new positions, no deposits |
| `ACTION_FAIL_ALERT` | 5 | Consecutive failures before `action_failing` |
| `EMERGENCY_MAX_PREMIUM_BPS` | 1000 | When deleveraging, buy even at up to 10% above the oracle |
| `EXIT_MAX_PREMIUM_BPS` | 300 | During `exit`, buy even at up to 3% above the oracle |
| `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_HEADER` | — | Alert webhook (see [Alerts](#alerts)) |
| `AGGREGATOR` | `kyber` | `off` disables the aggregator path and uses single Uniswap pools only |
| `AGG_SLIPPAGE_BPS` | 100 | Slippage tolerance passed to the aggregator; the real price protection is the oracle floor in the contract |
| `WS_URL_<CHAIN>` | publicnode `wss://` | Subscribes to new blocks and decides as soon as one arrives (faster than polling); `off` disables it. Not subscribed if you change `RPC_URL(S)_<CHAIN>` without setting this |
| `POLL_MS` | 3000 | Polling interval (fallback when the WebSocket drops) |
| `MIN_TICK_MS` | 500 | Minimum time between two decisions (Arbitrum makes 4 blocks a second) |
| `LOG_MS` | 30000 | How often to print a line when nothing is happening |
| `MNEMONIC_INDEX` / `MNEMONIC_PATH` | — | Pick the mnemonic account directly instead of scanning |
| `ARB_ADDRESS_<CHAIN>` | `state.json` | Contract address to use |
| `BOT_LANG` | — | `en` = English messages; anything else = Traditional Chinese |

## Tests

```bash
forge test -vv
```

- Every chain test forks the real chain, uses ACL permissions to simulate governance unfreezing Aave (setting stablecoin LTV back to 75% if it is still 0), then moves a real Uniswap pool to create the premium.
- RPCs come from `ETH_RPC_URL`, `ARB_RPC_URL`, `BASE_RPC_URL`, `OP_RPC_URL`; pin blocks with `FORK_BLOCK`, `ARB_FORK_BLOCK`, `BASE_FORK_BLOCK`, `OP_FORK_BLOCK`,
  or leave them unset for the latest block.
- publicnode keeps only about the last 128 blocks of state for mainnet, Arbitrum and Optimism (about 30 seconds on Arbitrum), so the L2 tests default to the official RPCs.
  Re-running at a pinned block needs an archive RPC.
- All four chains together take about 2–3 minutes, mostly spent fetching state from RPCs.

Results on 2026-10-30: all 61 tests pass (19 on mainnet, 14 on each L2). Profit and loss numbers vary a little with the fork block.

| Chain (pool) | Profit at a 10% premium (100k USDC principal) |
|---|---|
| Mainnet (USDC 0.05%) | +13,974 USDC |
| Arbitrum (USDC 0.05%) | +14,721 USDC |
| Base (USDC 0.05%) | +13,681 USDC |
| Optimism (USDC 0.3%, a shallower pool) | +12,925 USDC |

Type-check the bot (TypeScript) with `cd bot && npm run typecheck` (`tsc --strict`).

| Test | What it checks |
|---|---|
| `test_profitWhenUniswapConvergesDown` | 10% premium → open → hold a day → Uniswap returns to the oracle price → close, on every chain |
| `test_open_revertsWithoutPremium` | No premium → `NoEdge` |
| `test_open_sizingEdgeSellsMore` | Sizing at half the premium sells more in the first transaction (67.6 → 72.5 WETH) and still meets the HF target, on every chain |
| `test_close_usesIdleStableFirst` | Idle stablecoins in the contract are used first when closing; Aave is tapped only for the rest, on every chain |
| `test_flashCallbacks_rejectOutsiders` / `…rejectForeignFlashLoan` | Aggregator-path flash-loan callbacks: anything not from Aave, not started by the contract, or not in progress is rejected; a flash loan someone else takes naming this contract as receiver also fails, on every chain |
| `test_openVia_guards` / `…revertsBelowEdge` / `…revertsWhenTooBig` | Router not allowlisted, caller not the owner, fill below "oracle × 1.005", or borrowing too much all revert the whole transaction, on every chain |
| `test_openVia_thenCloseVia` | Through a router (Uniswap SwapRouter02 in the test), sells 20 WETH to open and buys back to close: debt to zero, approvals to zero, profit; with a cap that's too low, `closeVia` refuses to overpay, on every chain |
| `test_crossStable_closesInChunks` (mainnet) | Position partly in a USDC pool, mostly in a USDT pool: when USDC can't cover all the debt it closes part without reverting, and alternates until the debt is zero; total assets > principal |
| `test_oracleUpByHfMinusOne_liquidatable` | An oracle rise of (HF − 1) makes the position liquidatable |
| `test_onlyOwner` / `test_callbackOnlyDuringOwnSwap` / `test_rejectsPoolNotFromFactory` | Access control |
| `test_profitOnWethToken0Pool` (mainnet) | WETH/USDT 0.3% pool (WETH is token0): at a 5% premium it still opens and closes, making 6,769 USDT |
| `test_open_stopsAtPriceLimit` (mainnet) | 1% premium, large principal: stops selling when the premium is down to 0.5% (after fees) |
| `test_open_respectsMaxWethIn` (mainnet) | The per-transaction cap works |
| `test_oracleCatchesUp_noProfit` (mainnet) | Oracle rises 10% to catch up: closing loses 166 USDC |

### After changing the contract

`start.ts` deploys `bot/OracleLagArb.json`, which records the sha256 of `src/`. If the source changed and the artifact wasn't re-exported, it refuses to deploy.

```bash
forge build && node bot/export-artifact.ts
```

### Manual operation (Foundry)

```bash
forge script script/Deploy.s.sol --rpc-url $ETH_RPC_URL --account <keystore name> --broadcast
cast send $ARB "open(address,uint256,uint256,uint256,uint256)" <pool> 50 50 1300000000000000000 0 --account <keystore>
cast send $ARB "close(address,uint256,uint256)" <pool> 30 0 --account <keystore>
cast send $ARB "withdraw(address,uint256,address)" $USDC $(cast max-uint) <your address> --account <keystore>
cast call $ARB "premiumBps(address)(int256)" <pool>
```

`Deploy.s.sol` defaults to mainnet addresses; for other chains override `AAVE_ADDRESSES_PROVIDER`, `WETH` and `UNI_V3_FACTORY` (addresses are in the chain config in `bot/core.ts`).
If you hold WETH, you can skip Uniswap and repay directly with `repayFromOwner(amount)` (approve WETH to the contract first).
Assets deposited into Aave while their LTV is 0 aren't enabled as collateral automatically; once LTV is restored, turn them on with `setCollateral(asset, true)`.

## How others did it

Compiled on 2026-10-30. Times are UTC. Items marked "single source" have only one source; the rest have at least two independent sources or primary data (on-chain records, Aave governance posts).

**This event**

- 20:24 the Binance hot wallet starts being drained; 20:34 the attacker swaps 50M USDT for 20,940 ETH through UniswapX, and the premium starts with that trade
  ([Decrypt](https://decrypt.co/382194/binance-hack-exit-ramps-defi-exchange-ethereum)).
- The premium showed up in Uniswap V3 WETH/USDT 0.3% and ETH/USDC 0.05% (single source). Around 21:00 Uniswap was at about 2,700 and Chainlink about 2,250
  ([The Defiant](https://thedefiant.io/news/markets/eth-trades-at-20-premium-on-uniswap-versus-binance)).
- The top trader already had about $37M USDC deposited on Aave mainnet, got in 24 minutes after the start, and **traded by hand in 18 transactions** of 300–1,000 ETH each through DEXs and aggregators,
  closing most of it within 2 hours. The top ten made about $6.36M combined across 206 sell transactions, on average about 10% above the oracle. No source mentions flash loans or atomic transactions
  (single source: [0xNaiXi](https://x.com/0xNaiXi/status/2115967318274789609)).
- The attacker also deposited 60M USDT between 20:57 and 21:01 and borrowed 19,762 WETH from Aave mainnet, competing with arbitrageurs for the same WETH pool
  ([TechFlow](https://www.techflowpost.com/en-US/article/34992), [Cointelegraph](https://cointelegraph.com/news/binance-linked-wallet-faces-possible-exploit-blockchain-researcher-warns)).
- After 21:30 the premium narrowed to 3–5% (single source). At 21:42 the Guardian started freezing (single source). **The window was closed by the premium converging, not by the freeze.**
- No evidence found of a premium on Arbitrum, Base or OP, nor of Spark, Morpho or Compound being used for this trade.

**Earlier, similar events**

- LUNA (2022-05): Chainlink's minAnswer pinned the oracle at $0.107 while the market was at $0.01; people used LUNA as collateral on Venus and Blizz to borrow out other assets
  ([rekt](https://rekt.news/venus-blizz-rekt)).
- CRV (2022-11): the Mango Markets exploiter deposited USDC on Aave and borrowed CRV to dump it as a short; CRV was squeezed and the position liquidated. Borrowing a token and selling it is a short, and it blows up when that token rises
  ([CoinDesk](https://coindesk.com/markets/2022/11/22/mango-exploiter-gets-liquidated-after-roiling-aave-using-20m-of-borrowed-curve-tokens)).
- Kelp (2026-04): an attacker borrowed 82,650 WETH from Aave in 46 minutes, and available WETH liquidity fell from about $689M to $1.5M in 1.4 hours
  ([Glassnode](https://research.glassnode.com/anatomy-of-a-liquidity-freeze/)). Available liquidity has to be part of the per-transaction cap.
- CAPO (2026-03): a misaligned parameter in Aave's wstETH oracle under-priced it by about 2.85%, and about $27M was wrongly liquidated
  ([The Block](https://www.theblock.co/post/393121)).

**What this project does because of that**: opens only after the premium lasts `CONFIRM_SECONDS`; caps each transaction by what Aave can lend and by the borrow cap; re-evaluates every block and adds in steps;
a price floor guarantees the worst fill; buys back automatically after convergence; doesn't open while frozen and deposits principal automatically after the unfreeze. Not done: exchange hedging, the reverse direction, other lending protocols.

## Rehearsal records (2026-10-30, anvil fork)

**Demo run (mainnet, current code, the GIF above)**: Aave frozen → the bot deploys and waits; unfreeze → it deposits 100,000 USDC;
Uniswap USDC 0.05% pushed to +10.09% → after 15 s it opens in two chunks (73.02 + 5.63 WETH; health factor 1.337, then 1.303); price pushed back to the oracle →
it buys back in two pools until each hits the +0.3% limit; `exit` buys the remaining 21.85 WETH and withdraws: **100,000 → 116,484.18 USDC**.

**Single chain (mainnet)**: starting from Aave's real frozen state, `node start.ts --yes --deposit 100000`:
deploy → principal pending → simulated unfreeze, automatic deposit → Uniswap pushed up 10%, opened in 3 transactions → closed after returning to the oracle price: **100,000 → 115,979 USDC**.
Opened again, stopped the bot, and ran `exit --yes` with a **mnemonic**: closed and withdrew in one round → wallet **134,537 USDC**.

**Multi-chain (mainnet + Base at once)**:

1. Each chain deploys its contract and approves; principal recorded as pending
2. Only mainnet unfreezes → mainnet deposits automatically; Base pushed up 10% but still frozen → alert `premium_open:base` (noting it can't borrow), no position
3. Base unfreezes → automatic deposit → the premium has already lasted longer than `CONFIRM_SECONDS`, so it opens right away in 3 transactions
4. Base returns to the oracle price → closes in one transaction in the USDC 0.3% pool: **100,000 → 116,262 USDC**
5. Opened again, then `exit --yes` with the mnemonic: mainnet withdrew 100,000.05 USDC; Base closed and withdrew in one round, **134,857 USDC**

**After review fixes (Optimism, USDC + USDT across stablecoins)**:

1. Bot started while Aave was frozen → deposited 100,000 USDC automatically after the unfreeze
2. USDT pool (shallow) pushed up 10% → stopped by the price floor after selling 12.3 WETH; USDC pool pushed up 10% → per-transaction cap 25 WETH: 25 + 25 + 25 + 3, stopped at HF 1.301
3. Prices converge → when buying back pushed the pool to the +0.3% limit it waited, bought again once the price came back, and closed in several rounds until the debt was zero: **100,000 → 116,198 (USDC + USDT)**
4. Opened again, then raised Aave's oracle by 25% (simulating the oracle catching up) → HF 1.04, `hf_low` alert → computed a 55.6 WETH buyback, skipped the USDT pool with only dust left,
   bought back 30.6 WETH in the USDC pool → **HF back to 1.326, with 48 WETH of position still held** (not cut entirely)
5. Deleted `state.json`, mnemonic with no account chosen → unattended mode refused; with `MNEMONIC_INDEX=0`, `exit` **found the contract again from the wallet's transaction history**, closed and withdrew
6. Cross-stablecoin `exit`: one round with USDT, then one buyback of the remaining 85.7 WETH in the USDC pool; out in two rounds (the same case took 13 rounds before the fix)

**Aggregator path (Base, real KyberSwap routes)**: DEX prices left alone, Aave's oracle lowered 10% (so the DEX looks 11% expensive), so that KyberSwap routes computed from real on-chain state can execute on the fork:

1. Deployed, KyberSwap router allowlisted automatically, 100,000 USDC deposited
2. The first few aggregator open simulations timed out (the fork fetches each contract on the route from the remote the first time), so the bot sold 81.08 WETH through a Uniswap pool instead;
   from the next block the aggregator simulation passed and it **opened through KyberSwap** 6.64 + 0.59 WETH (against 88.31 WETH of Aave debt), stopping at HF 1.300
3. With the oracle back at the real price, sent **`closeVia`** with a KyberSwap stablecoin → WETH route: bought back 30 WETH for 67,609 USDC, debt 88.31 → 58.25, router approval back to zero
4. `exit` closed the rest in one round and withdrew everything: wallet 99,697 USDC. The "premium" here came from lowering the oracle and putting it back (the same as the oracle catching up), so there was no profit to make, only fees;
   this rehearsal exercised the aggregator mechanics. For the profitable scenarios, see the sections above

Note: opening through the aggregator uses much more gas than a single pool (3.1M vs 0.75M here), which matters when mainnet gas is expensive; `MIN_WETH_PER_TX` doesn't account for that yet.
Closing tries single pools first because `closeVia` pays the extra 0.05% flash-loan fee. When KyberSwap rate-limits (HTTP 429), that chain uses single pools for 30 seconds.

Not rehearsed: actual inclusion through Flashbots Protect on mainnet (KyberSwap routes do carry our 10-minute deadline in the calldata, verified 2026-10-30);
KyberSwap quotes and execution in a real event; a real premium on Aerodrome/Velodrome pools; the bot on Arbitrum (only contract fork tests and read-only monitoring).

## License

AGPL-3.0-only, see [LICENSE](LICENSE). You may use, change and share it; if you distribute a modified version, or run one
for others over a network, you must offer its source under the same license.

Not financial advice. Use at your own risk; the software is unaudited. Full [disclaimer](DISCLAIMER.md).
