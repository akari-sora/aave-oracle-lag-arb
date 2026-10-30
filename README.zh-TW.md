# aave-oracle-lag-arb：Aave 預言機落後 Uniswap 時的套利

Uniswap 上的 ETH 比 Aave 的 Chainlink 預言機貴很多時，用預言機價跟 Aave 借 WETH、拿到 DEX 賣掉，等價差收斂再買回來還債。

[English](README.md)

正式的 repo、issue 和 release：https://gitlab.com/aa22396584/aave-oracle-lag-arb

## 做什麼

- 合約 `OracleLagArb`：把「存穩定幣 → 用預言機價借 WETH → 在 Uniswap 賣掉 → 存回 Aave」壓成一筆 flash swap 交易，賣出的價格下限在鏈上跟預言機比
- 機器人（TypeScript）：每個區塊盯以太坊主網、Arbitrum、Base、Optimism，價差持續才開倉，價差沒了就買回，健康因子變低時自己降槓桿
- Linux 上 24 小時跑的監管程式和設定腳本，加上健康檢查和 webhook 警示
- 一份 agent skill，讓 Claude Code、Codex、Hermes Agent、Grok Bot 或其他 agent 幫你安裝、顧著它

**風險：這是加了槓桿的 ETH 空單，不是無風險套利。ETH 漲太多會被清算；Aave 隨時可能凍結市場。**

## 背景

2026-10-29 Binance 熱錢包被盜、暫停提領，交易所裡的 ETH 搬不出來，Uniswap 上的 ETH 一度比外面貴 10%～30%。
Aave 的 ETH 價格來自 Chainlink 預言機，跟的是交易所的價格，所以 Aave 照便宜的價格借你 ETH。
當時的手動做法是：

1. 在 Aave 存 U
2. 用預言機的低價借出 ETH
3. 拿到 Uniswap 用高價賣掉，換回 U
4. 把 U 存回 Aave，回到第 2 步，一直重複
5. 等 Uniswap 的 ETH 價格回落，買回 ETH 把債全部還掉

賺最多的地址用約 $2,580 賣出 12,289 ETH，再用約 $2,297 買回 12,314 ETH，賺約 $3.47M
（[0xNaiXi](https://x.com/0xNaiXi/status/2115967318274789609)，[Chaincatcher](https://www.chaincatcher.com/en/article/2300192) 轉述）。
別人實際怎麼做的，見下面「別人怎麼做的」。

## 這個專案怎麼做

`src/OracleLagArb.sol` 用 Uniswap V3 的 flash swap，把上面第 2 到第 4 步的循環壓成**一筆交易**：

```
open(pool, minEdgeBps, targetHf, maxWethIn)
  Uniswap 先把 U 給合約 ──► 合約把 U 存進 Aave ──► 用預言機價借 WETH ──► WETH 付回給 Uniswap

close(pool, maxPremiumBps, maxWethOut)
  Uniswap 先把 WETH 給合約 ──► 合約還 Aave 的 WETH 債 ──► 從 Aave 提 U ──► U 付回給 Uniswap
```

- **賣到哪裡停**：賣出時把 Uniswap 的 `sqrtPriceLimitX96` 設在「預言機價 × (1 + minEdgeBps)」。
  Uniswap 價格被賣到這條線就自動停，所以每一顆 WETH 都至少比預言機貴 `minEdgeBps` 才賣。
  同時間有別人在搶的話，這筆交易只會少賣，不會用差的價格賣出。
- **賣多少**：由 `targetHf`（賣完後的健康因子）決定。抵押全是穩定幣、債全是 WETH 時：

  ```
  HF = (C·lt + V·(1+edge)·ltS) / (D + V) ≥ H   ⇒   V ≤ (C·lt − H·D) / (H − (1+edge)·ltS)
  ```

  C、D 是現有的抵押和債務，V 是這次要借的 WETH 價值（以預言機價計），lt、ltS 是清算門檻。
  公式假設每顆都剛好賣在價格下限（最差情況），實際賣得比較好，所以開完倉的健康因子會比 `targetHf` 高
  （測試裡設 1.3，結果是 1.37）。機器人會在下個區塊再加碼，直到 HF 回到目標附近。
- **買回**：`close` 只在 Uniswap 價格 ≤ 預言機 × (1 + maxPremiumBps) 時買，超過就停。部位大的時候，
  買回本身會把價格推上去，所以可能要分好幾筆。
- **部位記在合約名下**（Aave 的 user 是合約地址），只有部署者（owner）能操作。
  Uniswap 的 callback 只接受合約自己正在 swap 的那個池子，池子地址也會跟 Uniswap factory 比對。
- 穩定幣跟著池子走：在 WETH/USDC 池開倉，抵押品就是 USDC；在 WETH/USDT 池開倉就是 USDT。
  `close` 要用同一種穩定幣的池子，因為它要從 Aave 提出那種穩定幣付給 Uniswap。
- 每條鏈各部署一個合約、各放一份本金，機器人同時盯所有鏈。

**聚合器路徑**（`openVia`／`closeVia`）：單一 Uniswap 池子吃不下時，改用 KyberSwap 找最好的成交，能同時賣到 Uniswap V3／V4、
Aerodrome／Velodrome、Curve、做市商報價。開倉用 Aave flash loan 模式 2 借 WETH（不用還，結束時直接變成浮動利率債，不收手續費），
交給聚合器換成穩定幣存回 Aave；平倉用 flash loan 借 WETH 先還債，再拿穩定幣經聚合器換回 WETH 還 flash loan（手續費 0.05%）。
保護跟直接 flash swap 一樣嚴：
- flash loan 回呼只接受「Aave 呼叫、合約自己發起、而且正在進行中」的，別人拿 flash loan 指定這個合約當收款人會整筆失敗
- 聚合器 router 要 owner 加進白名單（`setRouter`，`node start.ts` 會自動加 KyberSwap）
- 每次只授權這一筆要賣的量，用完歸零
- 成交價在鏈上用預言機檢查：開倉換到的穩定幣至少「WETH × 預言機價 × (1 + minEdge)」，平倉付出去的不超過「(WETH + 手續費) × 預言機價 × (1 + maxPremium)」；
  量的是合約自己的餘額變化，不信聚合器回傳的數字

## 什麼情況賺、什麼情況虧

這個部位是**穩定幣抵押、WETH 負債，也就是對 ETH 做空**，它不是無風險套利。

| 價差怎麼收斂 | 結果 |
|---|---|
| Uniswap 跌回預言機價（交易所恢復提領，便宜的 ETH 流出來） | 賺到價差。測試：本金 100k USDC、溢價 10%，主網賺 **+14,593 USDC** |
| 預言機漲上去追平 Uniswap | 等於用原價買回，沒有利潤，還要付兩次 swap 手續費。測試：**−166 USDC** |
| ETH 整體大漲 | 虧損；漲太多會被清算 |

- **清算線**：健康因子跟預言機的 ETH 價格成反比。開倉後 HF = h，預言機只要漲 (h − 1) 就會被清算。
  HF 1.37 等於可以承受預言機上漲 37%。
- **對沖**：要變成真正的套利，得在交易所買等量的 ETH（交易所裡的 ETH 比較便宜）或開永續多單。
  這個專案沒有串接交易所。
- **Aave 會凍結市場**：這次事件 Aave 的 Guardian 一次凍結了 16 條鏈上的 V3 和 4 條鏈上的 V4，
  所以多鏈不等於分散凍結風險。凍結期間 `open` 會失敗，但還款和提款照常可以做。
  2026-10-30 查到主網、Arbitrum、Base、Optimism 的 WETH、USDC、USDT 都還是 frozen，LTV = 0。
- **凍結後穩定幣可能提不出來**：凍結後存款人撤出，主網 V3 USDC 利用率到 97.8%，部分市場到 100%。
  提領要等有人還款。手上最好在協議外留一些 ETH 或穩定幣。
- **借款利率**：大家都在借 WETH 時，利用率會衝到 slope2 區間，浮動利率可能非常高。抱越久成本越高。
- **被搶先**：`open` 是公開的套利交易，主網預設走 Flashbots Protect 送單。價格下限可以保證最差成交價，但保證不了一定成交。

## 支援範圍

| | 支援 | 不支援 |
|---|---|---|
| 鏈 | 以太坊主網、Arbitrum、Base、Optimism | 其他鏈（合約可以部署，但機器人沒有地址表）；非 EVM 鏈 |
| 借貸 | Aave V3 | Aave V4、Compound、Morpho、Spark（介面不同或沒測過） |
| 交易所 | Uniswap V3（合約直接 flash swap）；經 KyberSwap 聚合器：Uniswap V3／V4、Aerodrome／Velodrome、Curve、做市商報價；Aerodrome／Velodrome Slipstream 的價差偵測（Base、OP） | Uniswap V4、Curve 的價差偵測；CEX |
| 幣 | 借 WETH，抵押 USDC／USDT（Base 上 Aave 沒有 USDT） | 其他幣；反方向（DEX 比預言機便宜） |

## 檔案

```
src/OracleLagArb.sol                  合約
src/interfaces/External.sol           Aave V3 / Uniswap V3 介面（只放用到的）
test/ForkBase.sol                     各鏈共用的 fork 測試
test/OracleLagArb.t.sol               主網 fork 測試（共用 + 主網才有的）
test/L2Fork.t.sol                     Arbitrum、Base、Optimism fork 測試
script/Deploy.s.sol                   用 Foundry 部署
bot/start.ts                          入口：給錢包、部署、存本金、自動套利、出場、給排程和 agent 的檢查
bot/core.ts                           鏈設定、讀市場、送交易、機器人邏輯、警示
bot/keys.ts                           私鑰、助記詞、keystore、1Password、macOS 鑰匙圈
bot/OracleLagArb.json                 部署用的 ABI + bytecode（從 forge build 匯出，附原始碼 sha256）
bot/export-artifact.ts                改過合約後重新匯出上面那個檔
deploy/install.sh                     Linux：把 bot/ 打包成 bot/dist/aave-oracle-lag-arb.mjs，連同監管程式裝好
deploy/trader.sh                      監管程式：背景執行、掛掉重啟、狀態、檢查、出場
deploy/set-wallet.sh                  設定錢包（存成權限 600 的檔案），確認讀得到
deploy/set-alerts.sh                  設定警示 webhook，送一次測試
skills/aave-oracle-lag-arb/SKILL.md   給 AI agent 用的 skill：安裝、設定、排程檢查、出場
AGENTS.md                             給要改程式的 coding agent 看的說明
integrations/grok-bot.md              在 Grok Bot 上跑
```

## 使用

這一節是直接從原始碼跑（任何系統）。要在 Linux 上 24 小時跑，見下面「24 小時跑（Linux）」。

需要 Node 22.18 以上（或 23.6 以上），可以直接跑 `.ts`。第一次先裝依賴：

```bash
cd bot && npm install
```

### 一鍵開始

```bash
cd bot
caffeinate -i node start.ts      # caffeinate 防止 Mac 睡著；別的系統直接 node start.ts
```

程式會依序做這些事，每一步都會先問過才動手：

1. 要你給錢包（方式見下一節）
2. 每條鏈：錢包有 ETH 付 gas、也有 USDC／USDT 的話，部署合約（主網約 0.003 ETH，L2 幾乎不用錢），
   問你要存多少本金。Aave 凍結中存不進去時，會先授權，機器人在解凍的那個區塊自動存
3. 沒 ETH 或沒穩定幣的鏈只監控、推警示；已經有合約的話照樣看部位（例如持倉中 gas 用完，HF 變低還是會報），只是不送交易
4. 開始自動套利，每條鏈每個區塊判斷一次（規則見下）。Ctrl+C 停止，倉位會留著

合約地址記在 `bot/state.json`（只有地址，沒有 key）。

不想互動的話：

```bash
PRIVATE_KEY=0x... node start.ts --yes --deposit 100000     # 每條鏈各存 100000；--deposit all／0；--token USDT
node start.ts --chains mainnet,arbitrum                    # 只跑這幾條鏈
```

### 錢包怎麼給

執行時貼上下面任何一種（輸入時不顯示，也不會存檔），或放進環境變數 `PRIVATE_KEY`／`MNEMONIC`／`KEY`。
也可以用 `KEY_ENV=<另一個環境變數的名稱>` 或 `KEY_FILE=<放 key 的檔案路徑>`。

| 貼什麼 | 說明 |
|---|---|
| 私鑰 | 有沒有 `0x`、大小寫、引號、斷行都可以 |
| 助記詞 | 12～24 個字；換行、逗號、編號（`1.` `2)` `3、`）、大小寫都可以。英文、簡繁中文、日文、韓文、西法義捷葡都支援，中文可以不留空格。拼錯會提示最接近的字，檢查碼不對會擋下來 |
| keystore 檔路徑 | MetaMask 匯出、geth、`cast wallet import` 產生的 JSON，再問密碼 |
| `foundry:<名稱>` | 讀 `~/.foundry/keystores/<名稱>`，也可以用 `--account <名稱>` |
| `op://vault/item/field` | 用 1Password CLI（`op read`）讀 |

用助記詞時，會列出這組助記詞常用的幾個地址（MetaMask #0～#4、Ledger Live #1～#2）在每條鏈上的 ETH、穩定幣和合約，
預設選第一個有錢的。要指定就設 `MNEMONIC_INDEX=2` 或 `MNEMONIC_PATH="m/44'/60'/0'/0/7"`。

在 Mac 上第一次輸入後，會問要不要記在 macOS 鑰匙圈（預設不要）。記了之後下次直接按 Enter 就好。
存的是選中那個地址的私鑰，不是整組助記詞。`node start.ts forget` 刪掉。

### 出場

```bash
node start.ts exit
```

每條鏈：一直買回 WETH 到債務歸零，再把抵押全部提回錢包，掃掉合約裡的零頭。
- 合約一次只買「這種穩定幣付得起」的量，所以倉位分散在 USDC 和 USDT 時會分幾輪，輪流用兩種穩定幣付；只買得到一點點的池子會先跳過。
- Aave 凍結時也能用：凍結只擋新的存款和借款，不擋還款和提款。
- 平不掉時會說原因：池子都比預言機貴超過 `EXIT_MAX_PREMIUM_BPS`（預設 3%，晚點再跑或調高），
  或 Aave 的穩定幣現金被借光、抵押提不出來（**直接把穩定幣轉進合約地址**，合約付款時會先用它）。其他鏈照做。

換一台機器出場也可以：沒有 `state.json` 時，程式會掃這個錢包最近 300 筆交易部署過的合約，自動找回來。
也可以直接指定：`ARB_ADDRESS_MAINNET=0x… node start.ts exit`（其他鏈是 `ARB_ADDRESS_ARBITRUM`、`ARB_ADDRESS_BASE`、`ARB_ADDRESS_OPTIMISM`）。

### 其他指令

```bash
node start.ts status     # 每條鏈的合約部位（不用 key）
node start.ts watch      # 只看價差（不用 key）
node start.ts check      # 跑一次就結束，給排程或 agent 用（見「警示」）
node start.ts whoami     # 錢包地址和各鏈餘額（確認 key 讀得到，不送交易）
node start.ts forget     # 刪掉鑰匙圈裡記住的錢包
```

```
04:35:45 [Arbitrum] #519575059 預言機 $2239.41 | USDC 0.01% +0.06% | USDC 0.05% +0.04% | ... | Aave 凍結中
04:35:45 [Ethereum] #26303215 預言機 $2232.50 | USDT 0.01% +0.43% | USDT 0.05% +0.42% | ... | Aave 凍結中
```

沒事的時候每條鏈每 `LOG_MS`（30 秒）印一行；溢價超過開倉門檻的一半、有持倉或有交易在等上鏈時，每個區塊都印。

### 機器人的判斷

每條鏈各自、每個區塊依序判斷，前一條成立就不看後面。每筆交易都會先模擬（eth_call），模擬失敗就不送；
同一條鏈同一時間只會有一筆交易在等上鏈。

1. 上一筆還沒上鏈 → 等。上鏈了、nonce 已經被用掉、或 Flashbots 回 FAILED／CANCELLED／UNKNOWN 就放行；
   後備是主網 10 個區塊（L2 換算成差不多的時間）
2. 有待存的本金，而且 Aave 能存了（沒凍結、存款上限還有空間）→ 存
3. 有債、HF < `EMERGENCY_HF` → 不管價差還在不在，**只買回讓 HF 回到 `EMERGENCY_TARGET_HF` 所需的量**（多 5%），不一口氣全平；
   用這個價格買回反而會讓 HF 更低時才全平。沒有池子買得到時會提示：把穩定幣轉進合約，或用 `repayFromOwner` 直接拿 WETH 還
4. 有「能用的」池子溢價 ≥ `OPEN_PREMIUM_BPS`，而且已經連續 `CONFIRM_SECONDS` 秒 →
   **先問聚合器**：規模取「健康因子撐得住的量（用溢價的一半估）」和下面的單筆上限的小者，報價不到預言機下限就減半，最多 3 次，
   模擬通過就送 `openVia`。聚合器沒回應或報價都不夠好，才依溢價高低一個一個試單一 Uniswap 池子的 `open`，送出一筆就停。
   聚合器能用時，Aerodrome／Velodrome 池子顯示的溢價也算數。
   能用 = Aave 的 WETH 沒凍結、這種穩定幣能存（沒凍結、LTV > 0、存款上限有空間），而且池子裡至少有 `MIN_POOL_WETH` 顆 WETH（死池不算）。
   每筆最多賣 `MAX_WETH_PER_TX`、Aave 還能借出的 WETH × 95%、這種穩定幣還能存的量（換算成 WETH）× 95%，取最小。
   規模先用「溢價的一半」估（第一筆就開足），健康因子不夠合約會擋，再退回最保守的估法。
   能用的池子價差還在就繼續抱著，不平倉；只有死池或存不進去的池子顯示溢價時，照常走第 5 步
5. 有債、某個池子溢價 ≤ `CLOSE_PREMIUM_BPS` → 從 WETH 最便宜、而且合約有夠多對應穩定幣的池子開始買回。
   單一池子都平不了（例如都被推到價格上限 `NoEdge`）時改用聚合器 `closeVia`；緊急降槓桿和 `exit` 也一樣，池子不行就換聚合器

`CLOSE_ONLY=1` 時只做 1、3、5：不存本金、不開倉，只顧著把部位平掉。

### 真的要用時

- **機器人要一直開著**。這次第一名在事發後 24 分鐘進場，有效窗口大約一小時，筆電睡著就錯過了。
  在 Mac 上用 `caffeinate -i`，或放在不會關機的 Linux 機器上用監管程式跑（見下一節）。
- 現在（2026-10-30）Aave 凍結中，可以先跑 `node start.ts`：部署、授權本金、讓機器人等著，解凍後它會自己存。
  本金存進 Aave 之後也會領存款利息。
- 主網預設走 Flashbots Protect（`SEND_RPC_URL_MAINNET`）：不會被搶先或夾；會失敗的交易不會上鏈，也不扣 gas；
  但可能等好幾個區塊才上鏈，或根本沒上。L2 直接送給該鏈的 RPC。要搶速度可以設 `PRIORITY_FEE_GWEI`。
- 公開 RPC 偶爾會限流。每條鏈預設兩個公開 RPC，第一個失敗自動換第二個；有自己的 RPC（Alchemy、Infura…）就填進 `RPC_URLS_<鏈>`（逗號分隔，依序備援）。
- 開機時連不上、或設定沒做完的鏈，全自動模式（`--yes`）每分鐘重試，成功就開始顧；一條鏈出錯不影響其他鏈。

## 24 小時跑（Linux）

在要跑交易的那台機器上：

```bash
git clone https://gitlab.com/aa22396584/aave-oracle-lag-arb.git && cd aave-oracle-lag-arb
bash deploy/install.sh            # 加 --with-op 會一起裝 1Password CLI
~/.local/share/aave-oracle-lag-arb/set-wallet.sh
~/.local/share/aave-oracle-lag-arb/trader.sh start
```

從筆電裝到遠端伺服器（`host` 換成你的伺服器；`-t` 讓 `set-wallet.sh` 能用不顯示的輸入框問 key）：

```bash
ssh -t host 'git clone https://gitlab.com/aa22396584/aave-oracle-lag-arb.git && cd aave-oracle-lag-arb && bash deploy/install.sh && ~/.local/share/aave-oracle-lag-arb/set-wallet.sh'
ssh host ~/.local/share/aave-oracle-lag-arb/trader.sh start     # 在背景跑，ssh 斷了也繼續
```

### 安裝做了什麼

`deploy/install.sh`：

- 用 PATH 上的 Node 20 以上。沒有或太舊時（只限 Linux x64／arm64）下載固定版本的 Node 22、比對 sha256，只把 `node` 這個執行檔放進 `APP_DIR`
- `npm ci` 之後用 esbuild 把 `bot/` 打包成單一檔 `bot/dist/aave-oracle-lag-arb.mjs`，執行時不用 `node_modules`。原本沒有 `bot/node_modules` 的話，打包完會刪掉（小機器的 inode 比較緊）
- 把打包檔、`bot/OracleLagArb.json`、`trader.sh`、`set-wallet.sh`、`set-alerts.sh` 複製進 `APP_DIR`
- `--with-op`：把 1Password CLI 裝進 `APP_DIR`（只限 Linux x64／arm64，要有 `python3` 解壓縮）
- 機器人在跑的話會重啟；沒在跑就印出下一步

需要 `bash`、`git`、`curl`；要下載 Node 時還要 `sha256sum` 和能解 `.tar.xz` 的 `tar`。

| | 預設 | 放什麼 |
|---|---|---|
| `APP_DIR` | `~/.local/share/aave-oracle-lag-arb` | 打包好的機器人、`trader.sh` 等腳本、下載的 `node`／`op`、紀錄 `trader.log`、`state.json`（合約地址）、心跳和檢查狀態 |
| `ARB_CONFIG_DIR` | `~/.config/aave-oracle-lag-arb` | `env`（錢包和其他設定）、`alerts.env`（webhook）。檔案權限 600，資料夾 700 |

`APP_DIR` 只在安裝時用（`APP_DIR=/opt/arb bash deploy/install.sh`，之後更新也要設一樣的）；裝好的腳本自己知道在哪個資料夾。
`ARB_CONFIG_DIR` 改的話，每次跑 `set-wallet.sh`、`set-alerts.sh`、`trader.sh`（包括排程）都要設成一樣的。

### 設定錢包（set-wallet.sh）

```bash
APP=~/.local/share/aave-oracle-lag-arb
$APP/set-wallet.sh                                    # 不顯示的輸入框：私鑰、助記詞或 op://（op:// 會再問 service account token）
$APP/set-wallet.sh --from-env AAVE_BOT_KEY            # 複製這個環境變數的值（例如 agent 平台注入的秘密）
$APP/set-wallet.sh --env-name AAVE_BOT_KEY            # 只存變數名稱；機器人每次啟動時環境裡都要有它
$APP/set-wallet.sh --op op://vault/item/field         # 1Password；token 用不顯示的輸入框問
$APP/set-wallet.sh --op op://vault/item/field --token-from-env OP_TOKEN    # token 從環境變數拿
$APP/set-wallet.sh --index 2                          # 助記詞用 MetaMask #2
$APP/set-wallet.sh --path "m/44'/60'/1'/0/0"          # 助記詞用 Ledger Live #1
```

| 方式 | env 檔裡存什麼 |
|---|---|
| 輸入框、`--from-env` | `KEY=<值>`（私鑰或助記詞本身） |
| `--env-name` | `KEY_ENV=<名稱>`，只有名稱。機器重開後，排程的環境裡沒有這個變數的話，`ensure` 會說「this environment doesn't have it」並且不啟動 |
| `--op`、輸入框貼 `op://` | `OP_SERVICE_ACCOUNT_TOKEN` 和 `KEY=op://…`。建議開一個只放這把 key 的保險庫，token 只給讀這個保險庫的權限 |
| `--index`、`--path` | `MNEMONIC_INDEX`／`MNEMONIC_PATH`。單獨用時只換地址，key 不變；也可以跟上面的方式一起用 |

- key 不會印出來，也不會出現在指令參數裡。env 檔裡原本的其他設定（調參數的變數、RPC）會留著，只換錢包那幾行。
- 最後會跑 `trader.sh whoami`（不送交易），印出地址和每條鏈的餘額。
- 助記詞沒指定地址時，`whoami` 會失敗並列出地址，照提示用 `--index` 或 `--path` 選一個。全自動模式不猜地址：猜錯會把別的錢包的錢存進來，或重啟時換到另一個地址。
- keystore 檔每次啟動都要輸入密碼，監管程式在背景跑時沒辦法輸入，所以 24 小時跑請用私鑰、助記詞或 1Password。
- 不用 env 檔也可以：`trader.sh` 會讀環境裡的 `KEY`、`PRIVATE_KEY`、`MNEMONIC`、`KEY_ENV`、`KEY_FILE=<放 key 的檔案路徑>`。

### 控制（trader.sh）

```bash
$APP/trader.sh start        # 在背景跑；已經在跑就不動
$APP/trader.sh status       # 在不在跑、模式、上次結束、最後幾行紀錄
$APP/trader.sh logs         # 看紀錄
$APP/trader.sh whoami       # 錢包地址和各鏈餘額
$APP/trader.sh stop         # 停止（倉位留著）
$APP/trader.sh close-only   # 只平倉、不開新倉、不存本金
$APP/trader.sh exit         # 停止、平倉、把錢提回錢包
$APP/trader.sh ensure       # 給排程用：沒在跑就叫起來
$APP/trader.sh check        # 給排程用：健康檢查，印 JSON
```

| 指令 | 做什麼 |
|---|---|
| `start` | 在背景跑，關掉終端機或 ssh 也繼續；機器人結束了會自己重啟 |
| `ensure` | 跟 `start` 一樣，但沒設錢包、或是用 `stop` 停掉的，就安靜跳過；沿用上一次的模式 |
| `close-only` | 用只平倉模式重啟 |
| `stop` | 停止，倉位留著。之後 `ensure` 不會叫起來，要 `start` 才會 |
| `status` | 在不在跑、模式、上次結束的時間和結束碼、最後 8 行紀錄 |
| `logs` | 持續印出紀錄 |
| `whoami` | 錢包地址和每條鏈的餘額（確認 key 讀得到） |
| `check` | 跑一次健康檢查，印 JSON。結束碼 0 = 跟上次比沒變化，1 = 有變化，其他 = 出錯。不用 key（見「警示」） |
| `exit` | 停止，然後每條鏈平倉、把錢提回錢包。沒做完會改成只平倉模式重新啟動 |

### 監管程式會做的事

- 用 `start --yes --deposit all` 啟動機器人：**錢包裡的 USDC／USDT 都會存進合約當本金**（Aave 收得進去的鏈），ETH 留著付 gas。只平倉模式用 `--deposit 0`。
- 掛掉會自己重啟。跑超過 5 分鐘才結束的，10 秒後重啟；啟動後 5 分鐘內就結束算一次失敗，連續失敗 n 次就等 n × 30 秒，最多 5 分鐘，不會放棄。
  連續 3 次失敗、最後一次在 15 分鐘內時，`check` 會報 `trader_crashloop`。
- 用 `stop` 停掉的，`ensure` 不會叫起來。機器重開之後沒有東西會自動把它叫起來，要等排程下一次跑 `ensure`（見「交給 AI agent 跑」）。
- `exit` 沒做完（例如價格太貴、穩定幣提不出來）時，會改成只平倉模式重新啟動，繼續顧著部位；之後再跑一次 `exit`。
  `ensure` 會沿用只平倉模式，重開機之後也一樣。
- 紀錄在 `APP_DIR/trader.log`，超過 20 MB 就複製成 `trader.log.1` 再清空（每次啟動前和每 5 分鐘檢查）；心跳檔寫不進去（例如磁碟滿）不影響交易。
- 合約地址記在 `APP_DIR/state.json`。這個資料夾不見的話重跑 `install.sh` 即可：合約地址會從錢包的交易紀錄自動找回來，狀態檔會重建。

### 更新

```bash
cd aave-oracle-lag-arb && git pull && bash deploy/install.sh     # 在跑的話會重啟
```

安裝程式不會動 `ARB_CONFIG_DIR`，錢包和 webhook 設定會留著。

### key 的安全

- **好幾個 bot 或 agent 共用的機器（包括 agent 平台給的電腦），機器人跑起來之後，其他 bot 或 agent 都讀得到 key。**
  不管用哪種方式給錢包，機器人跑起來之後 key 就在那台電腦的程式裡。用一個專用錢包，只放這個策略要用的錢。
- env 檔權限 600、資料夾 700。三個腳本都不會把 key 印出來或放進指令參數。

### macOS

監管程式只支援 Linux（用到 `setsid` 和 `/proc`）。Mac 上在終端機跑：

```bash
cd bot && npm install && caffeinate -i node start.ts
```

### 驗證過的

2026-10-30 在雲端的 Linux x64 VM 上，用沒有錢的測試錢包驗證過：
- `install.sh`：用系統的 Node 20，以及下載固定版本的 Node 22
- `set-wallet.sh` 從環境變數讀：助記詞 → 列出地址 → `--index`；私鑰；`--env-name`，環境裡有這個變數和沒有的情況
- `set-alerts.sh` 的測試 POST：回 200 成功，回 404 失敗
- `trader.sh` 的 `start`、`status`、`stop`、`ensure`

還沒驗證：1Password 用真的 token 讀 key；Grok Bot 和 Hermes Agent 從頭到尾走一次。

## 交給 AI agent 跑

機器人不綁特定的 agent：所有操作都是 `deploy/` 裡的腳本，能跑 shell 的 agent 都能用。

| 檔案 | 用途 |
|---|---|
| `skills/aave-oracle-lag-arb/SKILL.md` | skill（[agentskills.io](https://agentskills.io) 格式）：安裝、設定錢包、啟動、排程檢查、讀警示、出場 |
| `.claude/skills/` | 連到上面那個 skill；用 Claude Code 打開這個 repo 時會讀到 |
| `.agents/skills/` | 同上，給 Codex |
| `AGENTS.md` | 給要改程式的 coding agent（Codex、Cursor；Claude Code 透過 CLAUDE.md 讀到） |

skill 裡寫的做法：key 不在一般對話裡給，而是用平台的遮罩輸入變成環境變數，再跑 `set-wallet.sh --from-env`；
啟動前給使用者看地址和餘額、問一次；`stop`、`close-only`、`exit` 只在使用者要求時跑。

### Claude Code／Codex／Cursor

在要跑交易的機器上打開這個 repo，跟它說「在這台機器上設定 oracle-lag 機器人」（set up the oracle-lag bot on this machine）。

想在任何資料夾都能用，把 skill 複製出去：

```bash
cp -r skills/aave-oracle-lag-arb ~/.claude/skills/    # Claude Code
cp -r skills/aave-oracle-lag-arb ~/.agents/skills/    # Codex
```

### Hermes Agent

```bash
cp -r skills/aave-oracle-lag-arb ~/.hermes/skills/
hermes skills list | grep aave-oracle-lag-arb   # 有沒有讀到；已經開著的對話用 /reload-skills 更新斜線指令
```

Hermes 也能用 `hermes skills install <owner>/<repo>/<路徑>` 從 GitHub 裝 skill：鏡像是 `akari-sora/aave-oracle-lag-arb`，
skill 路徑 `skills/aave-oracle-lag-arb`（沒測過）。
裝好之後請 Hermes 安裝機器人，並排程每 6 小時跑一次 `trader.sh ensure` 和 `trader.sh check`。

### Grok Bot

最快：打開範本 [https://x.ai/bot/4OryWRBkWbghpXyZytSSm](https://x.ai/bot/4OryWRBkWbghpXyZytSSm)，按 **Add to Grok Bot**。拿到的是你自己的一份 bot，錢包的秘密、例行任務和電腦都只屬於你。
接著跟它說「set up」和「set wallet」。細節和 persona（要自己建的話）在 [integrations/grok-bot.md](integrations/grok-bot.md)。
它會把機器人裝在 Grok Bot 的電腦上，
用遮罩的秘密卡片收 key，例行任務每 6 小時跑 `ensure` 和 `check`。另外建一個 webhook 觸發的例行任務，再用 `set-alerts.sh` 接上，就能收即時警示。

同一個 Grok 帳號的所有 bot 共用這台電腦（[官方](https://docs.x.ai/grok-bot/security-faq)：「Treat a login or file on the computer as available to every Bot that user runs」）。

### 其他 agent 或 cron

排程只要依序跑這兩個（每 6 小時就夠，機器人自己每個區塊都在判斷）：

```bash
APP=~/.local/share/aave-oracle-lag-arb
$APP/trader.sh ensure     # 沒在跑就叫起來；沒設錢包或用 stop 停掉的就跳過
$APP/trader.sh check      # 印一個 JSON 物件
```

`ensure` 印出 `started` 代表機器人之前掛了或機器重開過，值得說一聲。

| `check` 結束碼 | 意思 | 怎麼做 |
|---|---|---|
| 0 | 跟上次檢查比沒有變化 | 不用通知 |
| 1 | 有新出現或消失的項目 | 用一兩句話回報 `new` 和 `resolved` |
| 其他 | 出錯 | 回報一次錯誤訊息的前幾行，不要每次都報 |

```json
{"changed": true, "findings": [{"level": "warning", "code": "premium_open:base", "kind": "condition", "message": "…"}], "new": ["premium_open:base"], "resolved": []}
```

第一次跑只在有 warning／critical 時算變化。上一輪的狀態記在 `APP_DIR/check-state.json`。code 的意思見「警示」。
要即時通知的話，用 `set-alerts.sh` 設一個 webhook（payload 也在「警示」）。

只用 cron 的話：

```
@reboot      $HOME/.local/share/aave-oracle-lag-arb/trader.sh ensure
0 */6 * * *  $HOME/.local/share/aave-oracle-lag-arb/trader.sh ensure
```

cron 自己不會發訊息：搭配 webhook，或把 `trader.sh check` 包在自己的腳本裡，結束碼 1 時通知你。
cron 的 PATH 很短；`node` 不在 `/usr/bin` 的話（例如用 nvm 裝的），在 crontab 最上面設 `PATH=`。

## 警示

`check` 和 webhook 用同一份發現清單。code 後面接 `:鏈`（例如 `premium_open:arbitrum`），不同鏈出事算不同的消息。

| code | level | 觸發條件 |
|---|---|---|
| `premium_open:<鏈>` | warning | 最貴的池子溢價 ≥ `OPEN_PREMIUM_BPS`（Aave 凍結時訊息會註明借不到）。掉到門檻 − 1%（門檻低於 2% 時是一半）以下才算結束 |
| `hf_low:<鏈>` | critical | 有債而且 HF < `EMERGENCY_HF` |
| `bot_not_running:<鏈>` | warning | 有機會或有持倉，但這台機器上這條鏈的機器人一分鐘內沒有心跳（機器人旁邊的 `heartbeat-<鏈>.json`：從原始碼跑在 `bot/`，監管程式在 `APP_DIR`） |
| `action_failing:<鏈>` | warning | 機器人連續 `ACTION_FAIL_ALERT`（5）次動作沒成功：模擬失敗、交易失敗或沒上鏈。「價格到上限先等」不算 |
| `gas_low:<鏈>` | warning | 有部位，錢包的 ETH 低於主網 0.02／L2 0.002（緊急降槓桿會送不出去） |
| `trader_crashloop` | critical | `trader.sh` 底下的機器人連續 3 次啟動後 5 分鐘內就結束，最後一次在 15 分鐘內（例如 1Password 讀不到 key） |
| `rpc_error:<鏈>` | warning | 讀不到這條鏈的資料（只有 `check` 會出現） |
| `position_open:<鏈>` | info | 持倉中 |
| `aave_frozen:<鏈>` | info | 這條鏈 Aave V3 的 WETH 凍結中 |

### 排程查詢

`node start.ts check --json` 印出發現清單，有 warning／critical 時結束碼 1。訊息是繁體中文：

```json
[{"level": "warning", "code": "premium_open:mainnet", "kind": "condition", "message": "Ethereum Uniswap USDC 0.05% 的 ETH 比 Aave 預言機貴 +9.73%"}]
```

**只報變化**：`node start.ts check --json --state <檔案>` 記住上一輪的 code，有新出現或消失的項目才結束碼 1，輸出
`{"changed", "findings", "new", "resolved"}`；第一次跑只在有 warning／critical 時算變化。排程用這個，沒變化就不用通知。
`trader.sh check` 就是這個指令，狀態檔是 `APP_DIR/check-state.json`。

### 推播

`watch` 或機器人在跑的時候，設了 `ALERT_WEBHOOK_URL`（和 `ALERT_WEBHOOK_HEADER`，例如 `Authorization: Bearer …`），
某條鏈的清單有變化才 POST 一次（第一輪只在有 warning／critical 時送）：

```json
{"source": "aave-u-eth", "host": "…", "chain": "base", "time": "…", "block": "53272934", "findings": [...], "new": ["premium_open:base"], "resolved": []}
```

`aave_frozen:<鏈>` 出現在 `resolved` 就代表那條鏈的 Aave 解凍了。webhook 不等回應（逾時 10 秒），不會拖慢交易判斷。

### 設定 webhook（set-alerts.sh）

用監管程式跑時，網址和標頭存在 `ARB_CONFIG_DIR/alerts.env`（權限 600），重跑安裝程式不會蓋掉。

```bash
$APP/set-alerts.sh https://example.com/hook                              # 用不顯示的輸入框問標頭或 token
$APP/set-alerts.sh https://example.com/hook --header-from-env ALERT_KEY  # 從環境變數拿（例如 agent 平台注入的秘密）
$APP/set-alerts.sh https://example.com/hook --no-auth                    # 網址本身就帶著秘密
$APP/set-alerts.sh --off                                                 # 拿掉 webhook
```

- 只給 token 時會變成 `Authorization: Bearer <token>`；有冒號的就當整行標頭用。
- 存好之後送一次測試 POST，格式跟機器人送的一樣、只是沒有發現項目：
  `{"source":"aave-u-eth","test":true,"findings":[],"new":[],"resolved":[]}`。印出 HTTP 狀態碼，不是 2xx 就結束碼 1（設定還是存著，改好再跑一次，或 `--off`）。
- 標頭經過檔案描述子交給 curl，不會出現在指令參數裡。
- 機器人在跑的話會重啟，讓新設定生效。

## 設定

全部都有預設值。從原始碼跑時，把 `bot/.env.example` 複製成 `bot/.env`，程式啟動時會自動讀（已經設在環境變數裡的優先）。
用監管程式跑時，把要改的變數加進 `ARB_CONFIG_DIR/env`（`set-wallet.sh` 不會動到它們），再 `trader.sh stop && trader.sh start`。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `CHAINS` | `mainnet,arbitrum,base,optimism` | 跑哪幾條鏈 |
| `RPC_URLS_<鏈>` | 每條鏈兩個公開 RPC（見 `bot/core.ts`） | 讀資料、估 gas 用，逗號分隔、依序備援。`<鏈>` 是 `MAINNET`／`ARBITRUM`／`BASE`／`OPTIMISM`；只給一個用 `RPC_URL_<鏈>` |
| `SEND_RPC_URL_<鏈>` | 主網 `https://rpc.flashbots.net/fast`，L2 同 `RPC_URL_<鏈>` | 送交易用 |
| `PRIORITY_FEE_GWEI` | 自動估 | 給打包者的小費 |
| `GAS_LIMIT_MULT` | 1.25 | gas 上限 = 估計值 × 這個（估完到上鏈之間，flash swap 可能多跨幾個 tick） |
| `MAX_FEE_BASE_MULT` | 2 | maxFeePerGas = base fee × 這個 + 小費 |
| `OPEN_PREMIUM_BPS` | 300 | 溢價 ≥ 3% 才開 |
| `CONFIRM_SECONDS` | 15 | 溢價要連續這麼多秒都在門檻以上才開，過濾單筆大單造成、下個區塊就被套平的瞬間跳動（等待中的訊息每 `LOG_MS` 印一次） |
| `MIN_EDGE_BPS` | 50 | 賣到溢價剩 0.5% 就停 |
| `TARGET_HF` | 1.3 | 開倉後健康因子下限。至少 1.05（低於「清算門檻 ÷ LTV」Aave 會擋借款），啟動時檢查 |
| `MAX_WETH_PER_TX` | 0 | 單筆最多賣多少 WETH，0 = 只受 Aave 可借量限制 |
| `MIN_WETH_PER_TX` | 0.5 | 單筆少於這個量就不開 |
| `CLOSE_PREMIUM_BPS` | 30 | 溢價 ≤ 0.3% 就買回 |
| `EMERGENCY_HF` | 1.1 | 低於這個值就不挑價格先降槓桿 |
| `EMERGENCY_TARGET_HF` | 同 `TARGET_HF` | 降槓桿買回到 HF 回到這個值就停 |
| `MIN_POOL_WETH` | 5 | 池子裡少於這麼多 WETH 就當死池 |
| `CLOSE_ONLY` | — | `1` = 只平倉、不開倉、不存本金 |
| `ACTION_FAIL_ALERT` | 5 | 連續失敗幾次發 `action_failing` |
| `EMERGENCY_MAX_PREMIUM_BPS` | 1000 | 降槓桿時最多比預言機貴 10% 也買 |
| `EXIT_MAX_PREMIUM_BPS` | 300 | `exit` 時最多比預言機貴 3% 也買 |
| `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_HEADER` | — | 警示推播（見「警示」） |
| `AGGREGATOR` | `kyber` | `off` 關掉聚合器路徑，只用單一 Uniswap 池子 |
| `AGG_SLIPPAGE_BPS` | 100 | 給聚合器的滑價容忍；真正的價格保護是合約裡的預言機下限 |
| `WS_URL_<鏈>` | publicnode 的 `wss://` | 訂閱新區塊，一出來就判斷（比輪詢快）；`off` 關掉。換了 `RPC_URL(S)_<鏈>` 又沒給這個時不訂閱 |
| `POLL_MS` | 3000 | 輪詢間隔（WS 斷線時的後備） |
| `MIN_TICK_MS` | 500 | 兩次判斷至少隔多久（Arbitrum 每秒 4 個區塊） |
| `LOG_MS` | 30000 | 沒事的時候多久印一行 |
| `MNEMONIC_INDEX` / `MNEMONIC_PATH` | — | 助記詞直接指定地址，不掃 |
| `ARB_ADDRESS_<鏈>` | `state.json` | 指定合約地址 |

## 測試

```bash
forge test -vv
```

- 每條鏈都 fork 真的鏈，先用 ACL 權限模擬治理解凍 Aave（穩定幣的 LTV 還是 0 就設回 75%），再用真的 Uniswap 池子製造價差。
- RPC 用 `ETH_RPC_URL`、`ARB_RPC_URL`、`BASE_RPC_URL`、`OP_RPC_URL`；固定區塊用 `FORK_BLOCK`、`ARB_FORK_BLOCK`、`BASE_FORK_BLOCK`、`OP_FORK_BLOCK`，
  沒設就用最新區塊。
- publicnode 的主網、Arbitrum、Optimism 只保留最近約 128 個區塊的狀態（Arbitrum 只有約 30 秒），所以 L2 測試預設用官方 RPC。
  要固定區塊重跑，得用有 archive 的 RPC。
- 四條鏈一起跑大約 2～3 分鐘，大部分時間花在從 RPC 抓狀態。

2026-10-30 的結果：61 個測試全部通過（主網 19、每條 L2 各 14）。fork 的區塊不同，損益數字會差一點。

| 鏈（池子） | 溢價 10% 時的獲利（本金 100k USDC） |
|---|---|
| 主網（USDC 0.05%） | +13,974 USDC |
| Arbitrum（USDC 0.05%） | +14,721 USDC |
| Base（USDC 0.05%） | +13,681 USDC |
| Optimism（USDC 0.3%，池子比較淺） | +12,925 USDC |

機器人（TypeScript）用 `cd bot && npm run typecheck`（`tsc --strict`）檢查型別。

| 測試 | 內容 |
|---|---|
| `test_profitWhenUniswapConvergesDown` | 溢價 10% → open → 抱一天 → Uniswap 回到預言機價 → close，每條鏈都測 |
| `test_open_revertsWithoutPremium` | 沒價差就 `NoEdge` |
| `test_open_sizingEdgeSellsMore` | 估規模用溢價的一半時第一筆賣更多（67.6 → 72.5 WETH），HF 照樣達標，每條鏈都測 |
| `test_close_usesIdleStableFirst` | 合約手上閒置的穩定幣平倉時先用，不夠才從 Aave 提，每條鏈都測 |
| `test_flashCallbacks_rejectOutsiders` / `…rejectForeignFlashLoan` | 聚合器路徑的 flash loan 回呼：不是 Aave、不是自己發起、不在進行中的一律拒絕；別人拿 Aave flash loan 指定這個合約當收款人也會失敗，每條鏈都測 |
| `test_openVia_guards` / `…revertsBelowEdge` / `…revertsWhenTooBig` | router 不在白名單、不是 owner、成交價低於「預言機 × 1.005」、借太多都會整筆 revert，每條鏈都測 |
| `test_openVia_thenCloseVia` | 用 router（測試用 Uniswap SwapRouter02）賣 20 WETH 開倉、買回平倉：債務歸零、授權歸零、賺錢；上限太低時 `closeVia` 拒絕多付，每條鏈都測 |
| `test_crossStable_closesInChunks`（主網） | 倉位一部分在 USDC 池、大部分在 USDT 池：USDC 付不起全部債時只平一部分、不 revert，輪流平到債務歸零，總資產 > 本金 |
| `test_oracleUpByHfMinusOne_liquidatable` | 預言機漲 (HF − 1) 就會被清算 |
| `test_onlyOwner` / `test_callbackOnlyDuringOwnSwap` / `test_rejectsPoolNotFromFactory` | 權限 |
| `test_profitOnWethToken0Pool`（主網） | WETH/USDT 0.3% 池（WETH 是 token0），溢價 5% 一樣能開、能平，賺 6,769 USDT |
| `test_open_stopsAtPriceLimit`（主網） | 溢價 1%、本金大：賣到價差剩 0.5%（扣手續費後）就停 |
| `test_open_respectsMaxWethIn`（主網） | 單筆上限有效 |
| `test_oracleCatchesUp_noProfit`（主網） | 預言機漲 10% 追平：平倉虧 166 USDC |

### 改了合約之後

`start.ts` 部署的是 `bot/OracleLagArb.json`，裡面記了 `src/` 的 sha256；原始碼改過卻沒重新匯出，它會拒絕部署。

```bash
forge build && node bot/export-artifact.ts
```

### 手動操作（Foundry）

```bash
forge script script/Deploy.s.sol --rpc-url $ETH_RPC_URL --account <keystore 名稱> --broadcast
cast send $ARB "open(address,uint256,uint256,uint256,uint256)" <pool> 50 50 1300000000000000000 0 --account <keystore>
cast send $ARB "close(address,uint256,uint256)" <pool> 30 0 --account <keystore>
cast send $ARB "withdraw(address,uint256,address)" $USDC $(cast max-uint) <你的地址> --account <keystore>
cast call $ARB "premiumBps(address)(int256)" <pool>
```

`Deploy.s.sol` 預設是主網地址；其他鏈用 `AAVE_ADDRESSES_PROVIDER`、`WETH`、`UNI_V3_FACTORY` 覆蓋（地址見 `bot/core.ts` 的鏈設定）。
手上有 WETH 也可以不經過 Uniswap，直接用 `repayFromOwner(amount)` 還債（要先 approve WETH 給合約）。
資產在 LTV = 0 時存進 Aave 不會自動算抵押，LTV 恢復後用 `setCollateral(asset, true)` 打開。

## 別人怎麼做的

2026-10-30 整理。時間是 UTC；標「單一來源」的只有一個出處，其餘至少兩個獨立來源或一手資料（鏈上紀錄、Aave 治理文）。

**這次事件**

- 20:24 Binance 熱錢包開始被盜轉；20:34 駭客把 50M USDT 經 UniswapX 換成 20,940 ETH，溢價從這筆開始
  （[Decrypt](https://decrypt.co/382194/binance-hack-exit-ramps-defi-exchange-ethereum)）。
- 溢價出現在 Uniswap V3 WETH/USDT 0.3% 和 ETH/USDC 0.05%（單一來源）。約 21:00 時 Uniswap 約 2,700，Chainlink 約 2,250
  （[The Defiant](https://thedefiant.io/news/markets/eth-trades-at-20-premium-on-uniswap-versus-binance)）。
- 第一名事先已經在 Aave 主網存好約 $37M USDC，事發後 24 分鐘進場，**手動分 18 筆**，每筆 300～1,000 ETH，走 DEX 和聚合器，
  大部分在 2 小時內平倉。前十名合計約 $6.36M，共 206 筆賣單，平均比預言機高約 10%。沒有任何來源提到閃電貸或原子交易
  （單一來源：[0xNaiXi](https://x.com/0xNaiXi/status/2115967318274789609)）。
- 駭客自己也在 20:57～21:01 存 60M USDT、從 Aave 主網借走 19,762 WETH，跟套利者搶同一池 WETH
  （[TechFlow](https://www.techflowpost.com/en-US/article/34992)、[Cointelegraph](https://cointelegraph.com/news/binance-linked-wallet-faces-possible-exploit-blockchain-researcher-warns)）。
- 21:30 以後價差縮到 3～5%（單一來源）。21:42 Guardian 開始凍結（單一來源）。**窗口是價差收斂關掉的，不是凍結**。
- 沒找到 Arbitrum、Base、OP 出現溢價的證據；也沒找到 Spark、Morpho、Compound 被拿來做這個套利的證據。

**以前的類似事件**

- LUNA（2022-05）：Chainlink 的 minAnswer 讓預言機卡在 $0.107，市價 $0.01，有人在 Venus、Blizz 用 LUNA 抵押把別的資產借光
  （[rekt](https://rekt.news/venus-blizz-rekt)）。
- CRV（2022-11）：Mango Markets 的攻擊者在 Aave 存 USDC、借 CRV 拋售做空，CRV 被軋空、部位被清算。借幣賣出就是做空，那個幣一漲就爆倉
  （[CoinDesk](https://coindesk.com/markets/2022/11/22/mango-exploiter-gets-liquidated-after-roiling-aave-using-20m-of-borrowed-curve-tokens)）。
- Kelp（2026-04）：攻擊者 46 分鐘內從 Aave 借走 82,650 WETH，WETH 可用流動性 1.4 小時內從約 $689M 掉到 $1.5M
  （[Glassnode](https://research.glassnode.com/anatomy-of-a-liquidity-freeze/)）。可借量要納入單筆上限。
- CAPO（2026-03）：Aave 的 wstETH 預言機參數錯位、報價低估約 2.85%，約 $27M 被誤清算
  （[The Block](https://www.theblock.co/post/393121)）。

**這個專案因此做的**：價差持續 `CONFIRM_SECONDS` 才開倉；單筆受 Aave 可借量和 borrow cap 限制；每個區塊重新評估、分批加碼；
價格下限保證最差成交價；收斂後自動買回；凍結時不開倉、解凍後自動存本金。沒做的：交易所對沖、反方向、其他借貸協議。

## 演練紀錄（2026-10-30，anvil fork）

**單鏈（主網）**：從 Aave 真的凍結的狀態開始，`node start.ts --yes --deposit 100000`：
部署 → 待存 → 模擬解凍後自動存入 → Uniswap 推高 10%，分 3 筆開倉 → 回到預言機價後平倉：**100,000 → 115,979 USDC**。
再開一次倉後停掉機器人，用**助記詞**跑 `exit --yes`，一輪平倉、提領 → 錢包 **134,537 USDC**。

**多鏈（主網 + Base 同時跑）**：

1. 兩條鏈各自部署合約、授權，本金記成待存
2. 只有主網解凍 → 主網自動存入；Base 推高 10% 但還凍結 → 推播 `premium_open:base`（註明借不到），不開倉
3. Base 解凍 → 自動存入 → 溢價已經持續超過 `CONFIRM_SECONDS`，馬上分 3 筆開倉
4. Base 回到預言機價 → 在 USDC 0.3% 池一筆平倉：**100,000 → 116,262 USDC**
5. 再開一次倉後用助記詞 `exit --yes`：主網提領 100,000.05 USDC；Base 一輪平倉、提領 **134,857 USDC**

**審查修正後（Optimism，USDC + USDT 跨穩定幣）**：

1. 機器人在 Aave 凍結時啟動 → 解凍後自動存入 100,000 USDC
2. USDT 池（淺）推高 10% → 賣 12.3 WETH 就被價格下限擋住；USDC 池推高 10% → 單筆上限 25 WETH：25 + 25 + 25 + 3，HF 1.301 停
3. 價格收斂 → 買回把池子推到 +0.3% 上限時「先等」，價格回來再買，分幾輪平到債務歸零：**100,000 → 116,198（USDC + USDT）**
4. 再開倉後把 Aave 預言機調高 25%（模擬預言機往上追）→ HF 1.04，發 `hf_low` → 算出要買回 55.6 WETH，跳過只剩零頭的 USDT 池，
   在 USDC 池買回 30.6 WETH → **HF 回到 1.326，還留著 48 WETH 部位**（不是全部砍掉）
5. 刪掉 `state.json`，助記詞沒指定地址 → 全自動模式拒絕；指定 `MNEMONIC_INDEX=0` 跑 `exit` → **從錢包交易紀錄找回合約**，平倉、提領
6. 跨穩定幣的 `exit`：先用 USDT 那輪、再一次在 USDC 池買回剩下的 85.7 WETH，兩輪就出場（修正前同樣情況跑了 13 輪）

**聚合器路徑（Base，用真的 KyberSwap 路由）**：DEX 價格不動，把 Aave 預言機調低 10%（DEX 看起來貴 11%），讓 KyberSwap 照真實鏈上狀態算出的路由能在 fork 上執行：

1. 部署、自動把 KyberSwap router 加進白名單、存入 100,000 USDC
2. 前幾次經聚合器開倉的模擬逾時（fork 第一次碰到路由經過的合約要從遠端抓），機器人改走 Uniswap 池子賣 81.08 WETH；
   下一個區塊起聚合器模擬過了，**經 KyberSwap 開倉** 6.64 + 0.59 WETH（對上 Aave 的債 88.31 WETH），HF 1.300 停
3. 預言機調回真實價格後，用 KyberSwap 的穩定幣 → WETH 路由送 **`closeVia`**：買回 30 WETH、付 67,609 USDC，債 88.31 → 58.25，給 router 的授權歸零
4. `exit` 一輪平掉剩下的、全部提領：錢包 99,697 USDC。這次的「價差」是把預言機調低再調回造成的（等於預言機往上追），本來就賺不到錢，只付手續費；
   這次演練的是聚合器路徑的機制，獲利情境看上面幾段

注意：經聚合器開倉的 gas 比單一池子多很多（這次 3.1M 對 0.75M），主網 gas 貴的時候成本差距明顯；`MIN_WETH_PER_TX` 還沒把這個算進去。
平倉先用單一池子，是因為 `closeVia` 要多付 flash loan 手續費 0.05%。KyberSwap 有被限流（HTTP 429）時，那條鏈 30 秒內改走單一池子。

沒演練過：Flashbots Protect 在主網上的實際上鏈（KyberSwap 路由的期限有照我們給的 10 分鐘寫進 calldata，2026-10-30 驗證過）、
真實事件中 KyberSwap 的報價和執行、Aerodrome／Velodrome 池子真的出現溢價的情況、Arbitrum 上的機器人（只有合約 fork 測試和唯讀監控）。

## 授權

MIT，見 [LICENSE](LICENSE)。

這不是投資建議，使用風險自負。放真的錢之前，請自己審過合約和程式。
