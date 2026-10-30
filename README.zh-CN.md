# aave-oracle-lag-arb：Aave 预言机落后 Uniswap 时的套利

Uniswap 上的 ETH 比 Aave 的 Chainlink 预言机贵很多时，按预言机价从 Aave 借出 WETH、拿到 DEX 卖掉，等价差收敛再买回来还债。

[English](README.md) · [繁體中文](README.zh-TW.md) · 简体中文 · [日本語](README.ja.md) · [한국어](README.ko.md)

正式的 repo、issue 和 release：https://gitlab.com/aa22396584/aave-oracle-lag-arb

## 做什么

- 合约 `OracleLagArb`：把“存稳定币 → 按预言机价借 WETH → 在 Uniswap 卖掉 → 存回 Aave”压成一笔 flash swap 交易，卖出的价格下限在链上跟预言机比对
- 机器人（TypeScript）：每个区块盯以太坊主网、Arbitrum、Base、Optimism，价差持续才开仓，价差消失就买回，健康因子变低时自动降杠杆
- Linux 上 24 小时运行的监管程序和配置脚本，外加健康检查和 webhook 告警
- 一份 agent skill，让 Claude Code、Codex、Hermes Agent、Grok Bot 或其他 agent 帮你安装、看管它

**风险：这是加了杠杆的 ETH 空单，不是无风险套利。ETH 涨太多会被清算；Aave 随时可能冻结市场。使用前请先阅读[免责声明](DISCLAIMER.zh-CN.md)。**

![主网 fork 演练](docs/demo.gif)

*用当前代码在本地 anvil fork 的以太坊主网演练：Aave 解冻、把 Uniswap 的 ETH 推到比预言机贵 10%、机器人开仓、价格收敛、平仓出场：100,000 → 116,484 USDC。事件是模拟的、时间有压缩，不是真实交易。*

## 背景

2026-10-29 Binance 热钱包被盗、暂停提币，交易所里的 ETH 提不出来，Uniswap 上的 ETH 一度比场外贵 10%～30%。
Aave 的 ETH 价格来自 Chainlink 预言机，跟的是交易所的价格，所以 Aave 按便宜的价格借给你 ETH。
当时的手动做法是：

1. 在 Aave 存 U
2. 按预言机的低价借出 ETH
3. 拿到 Uniswap 以高价卖掉，换回 U
4. 把 U 存回 Aave，回到第 2 步，循环往复
5. 等 Uniswap 的 ETH 价格回落，买回 ETH 把债全部还清

赚最多的地址以约 $2,580 卖出 12,289 ETH，再以约 $2,297 买回 12,314 ETH，赚约 $3.47M
（[0xNaiXi](https://x.com/0xNaiXi/status/2115967318274789609)，[Chaincatcher](https://www.chaincatcher.com/en/article/2300192) 转述）。
别人实际是怎么操作的，见下文“别人怎么做的”。

## 这个项目怎么做

![流程](docs/diagram.png)

`src/OracleLagArb.sol` 用 Uniswap V3 的 flash swap，把上面第 2 到第 4 步的循环压成**一笔交易**：

```
open(pool, minEdgeBps, targetHf, maxWethIn)
  Uniswap 先把 U 給合約 ──► 合約把 U 存進 Aave ──► 用預言機價借 WETH ──► WETH 付回給 Uniswap

close(pool, maxPremiumBps, maxWethOut)
  Uniswap 先把 WETH 給合約 ──► 合約還 Aave 的 WETH 債 ──► 從 Aave 提 U ──► U 付回給 Uniswap
```

- **卖到哪里停**：卖出时把 Uniswap 的 `sqrtPriceLimitX96` 设在“预言机价 × (1 + minEdgeBps)”。
  Uniswap 价格被砸到这条线就自动停，所以每一颗 WETH 都至少比预言机贵 `minEdgeBps` 才卖。
  同一时间有别人在抢的话，这笔交易只会少卖，不会以差的价格成交。
- **卖多少**：由 `targetHf`（卖完后的健康因子）决定。抵押全是稳定币、负债全是 WETH 时：

  ```
  HF = (C·lt + V·(1+edge)·ltS) / (D + V) ≥ H   ⇒   V ≤ (C·lt − H·D) / (H − (1+edge)·ltS)
  ```

  C、D 是现有的抵押和债务，V 是这次要借的 WETH 价值（按预言机价计），lt、ltS 是清算阈值。
  公式假设每颗都刚好卖在价格下限（最差情况），实际卖得更好，所以开完仓的健康因子会比 `targetHf` 高
  （测试里设 1.3，结果是 1.37）。机器人会在下个区块继续加仓，直到 HF 回到目标附近。
- **买回**：`close` 只在 Uniswap 价格 ≤ 预言机 × (1 + maxPremiumBps) 时买，超过就停。仓位大的时候，
  买回本身会把价格推高，所以可能要分好几笔。
- **仓位记在合约名下**（Aave 的 user 是合约地址），只有部署者（owner）能操作。
  Uniswap 的 callback 只接受合约自己正在 swap 的那个池子，池子地址也会跟 Uniswap factory 比对。
- 稳定币跟着池子走：在 WETH/USDC 池开仓，抵押品就是 USDC；在 WETH/USDT 池开仓就是 USDT。
  `close` 要用同一种稳定币的池子，因为它要从 Aave 提出那种稳定币付给 Uniswap。
- 每条链各部署一个合约、各放一份本金，机器人同时盯所有链。

**聚合器路径**（`openVia`／`closeVia`）：单一 Uniswap 池子吃不下时，改用 KyberSwap 寻找最优成交，能同时卖到 Uniswap V3／V4、
Aerodrome／Velodrome、Curve、做市商报价。开仓用 Aave flash loan 模式 2 借 WETH（不用归还，结束时直接转为浮动利率债，不收手续费），
交给聚合器换成稳定币存回 Aave；平仓用 flash loan 借 WETH 先还债，再拿稳定币经聚合器换回 WETH 还 flash loan（手续费 0.05%）。
安全保护跟直接 flash swap 一样严：
- flash loan 回调只接受“Aave 调用、合约自己发起、且正在进行中”的，别人拿 flash loan 指定这个合约当收款人会整笔回滚
- 聚合器 router 需由 owner 加进白名单（`setRouter`，`node start.ts` 会自动加 KyberSwap）
- 每次只授权当前这笔要卖的量，用完清零
- 成交价在链上用预言机检查：开仓换到的稳定币至少“WETH × 预言机价 × (1 + minEdge)”，平仓付出去的不超过“(WETH + 手续费) × 预言机价 × (1 + maxPremium)”；
  校验的是合约自身的余额变化，不信任聚合器返回的数字

## 什么情况赚、什么情况亏

这个仓位是**稳定币抵押、WETH 负债，也就是做空 ETH**，它不是无风险套利。

| 价差怎么收敛 | 结果 |
|---|---|
| Uniswap 跌回预言机价（交易所恢复提币，便宜的 ETH 流出来） | 赚到价差。测试：本金 100k USDC、溢价 10%，主网赚 **+14,593 USDC** |
| 预言机涨上去追平 Uniswap | 等于按原价买回，没有利润，还要付两次 swap 手续费。测试：**−166 USDC** |
| ETH 整体大涨 | 亏损；涨太多会被清算 |

- **清算线**：健康因子跟预言机的 ETH 价格成反比。开仓后 HF = h，预言机只要涨 (h − 1) 就会被清算。
  HF 1.37 等于可以承受预言机上涨 37%。
- **对冲**：要变成真正的套利，得在交易所买入等量的 ETH（交易所里的 ETH 更便宜）或开永续多单。
  本项目没有对接交易所。
- **Aave 会冻结市场**：这次事件 Aave 的 Guardian 一次性冻结了 16 条链上的 V3 和 4 条链上的 V4，
  所以多链不等于分散冻结风险。冻结期间 `open` 会失败，但还款和提款照常可以进行。
  2026-10-30 查到主网、Arbitrum、Base、Optimism 的 WETH、USDC、USDT 都还是 frozen，LTV = 0。
- **冻结后稳定币可能提不出来**：冻结后存款人撤出，主网 V3 USDC 利用率飙到 97.8%，部分市场到 100%。
  提款要等有人还款。手里最好在协议外留一些 ETH 或稳定币。
- **借款利率**：大家都在借 WETH 时，利用率会冲到 slope2 区间，浮动利率可能非常高。持仓越久成本越高。
- **被抢跑**：`open` 是公开的套利交易，主网默认走 Flashbots Protect 发交易。价格下限可以保证最差成交价，但保证不了一定成交。

## 支持范围

| | 支持 | 不支持 |
|---|---|---|
| 链 | 以太坊主网、Arbitrum、Base、Optimism | 其他链（合约可以部署，但机器人没有地址表）；非 EVM 链 |
| 借贷 | Aave V3 | Aave V4、Compound、Morpho、Spark（接口不同或未测试） |
| 交易所 | Uniswap V3（合约直接 flash swap）；经 KyberSwap 聚合器：Uniswap V3／V4、Aerodrome／Velodrome、Curve、做市商报价；Aerodrome／Velodrome Slipstream 的价差检测（Base、OP） | Uniswap V4、Curve 的价差检测；CEX |
| 币种 | 借 WETH，抵押 USDC／USDT（Base 上 Aave 没有 USDT） | 其他币种；反方向（DEX 比预言机便宜） |

## 文件

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

这一节是直接从源码运行（任何系统）。要在 Linux 上 24 小时运行，见下文“24 小时运行（Linux）”。

需要 Node 22.18 以上（或 23.6 以上），可以直接运行 `.ts`。首次使用先安装依赖：

```bash
cd bot && npm install
```

### 一键开始

```bash
cd bot
caffeinate -i node start.ts      # caffeinate 防止 Mac 睡著；別的系統直接 node start.ts
```

程序会按顺序做这些事，每一步都会先询问再动手：

1. 让你提供钱包（方式见下一节）
2. 每条链：钱包有 ETH 付 gas、也有 USDC／USDT 的话，部署合约（主网约 0.003 ETH，L2 几乎不要钱），
   询问你要存多少本金。Aave 冻结中存不进去时，会先授权，机器人在解冻的那个区块自动存入
3. 没 ETH 或没稳定币的链只监控、推告警；已经有合约的话照样看仓位（例如持仓中 gas 用完，HF 变低还是会报），只是不发交易
4. 开始自动套利，每条链每个区块判断一次（规则见下）。Ctrl+C 停止，仓位会保留

合约地址记在 `bot/state.json`（只有地址，没有 key）。

不想交互的话：

```bash
PRIVATE_KEY=0x... node start.ts --yes --deposit 100000     # 每條鏈各存 100000；--deposit all／0；--token USDT
node start.ts --chains mainnet,arbitrum                    # 只跑這幾條鏈
```

### 钱包怎么提供

运行时粘贴下面任意一种（输入时不明文回显，也不会写入文件），或放进环境变量 `PRIVATE_KEY`／`MNEMONIC`／`KEY`。
也可以用 `KEY_ENV=<另一个环境变量的名称>` 或 `KEY_FILE=<存放 key 的文件路径>`。

| 粘贴什么 | 说明 |
|---|---|
| 私钥 | 有没有 `0x`、大小写、引号、换行都可以 |
| 助记词 | 12～24 个词；换行、逗号、编号（`1.` `2)` `3、`）、大小写都可以。英文、简／繁体中文、日文、韩文、西法意捷葡都支持，中文可以不留空格。拼错会提醒最接近的词，校验码不对会拦截 |
| keystore 文件路径 | MetaMask 导出、geth、`cast wallet import` 生成的 JSON，再询问密码 |
| `foundry:<名称>` | 读取 `~/.foundry/keystores/<名称>`，也可以用 `--account <名称>` |
| `op://vault/item/field` | 用 1Password CLI（`op read`）读取 |

使用助记词时，会列出这组助记词常用的几个地址（MetaMask #0～#4、Ledger Live #1～#2）在每条链上的 ETH、稳定币和合约，
默认选第一个有余额的。要指定就设置 `MNEMONIC_INDEX=2` 或 `MNEMONIC_PATH="m/44'/60'/0'/0/7"`。

在 Mac 上第一次输入后，会询问要不要保存在 macOS 钥匙串（默认不保存）。保存之后下次直接按 Enter 即可。
存的是选中那个地址的私钥，不是整组助记词。`node start.ts forget` 可删除。

### 出场

```bash
node start.ts exit
```

每条链：持续买回 WETH 直到债务归零，再把抵押全部提回钱包，扫空合约里的零头。
- 合约一次只买“当前稳定币付得起”的量，所以仓位分散在 USDC 和 USDT 时会分几轮，轮流用两种稳定币支付；只买得到一点点的池子会先跳过。
- Aave 冻结时也能用：冻结只拦截新的存款和借款，不拦截还款和提款。
- 平不掉时会说明原因：池子都比预言机贵超过 `EXIT_MAX_PREMIUM_BPS`（默认 3%，晚点再跑或调高），
  或 Aave 的稳定币现金被借光、抵押提不出来（**直接把稳定币转进合约地址**，合约付款时会优先用它）。其他链照做。

换一台机器出场也可以：没有 `state.json` 时，程序会扫描这个钱包最近 300 笔交易部署过的合约，自动找回来。
也可以直接指定：`ARB_ADDRESS_MAINNET=0x… node start.ts exit`（其他链是 `ARB_ADDRESS_ARBITRUM`、`ARB_ADDRESS_BASE`、`ARB_ADDRESS_OPTIMISM`）。

### 其他命令

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

没事的时候每条链每 `LOG_MS`（30 秒）打印一行；溢价超过开仓阈值的一半、有持仓或有交易在等上链时，每个区块都打印。

### 机器人的判断

每条链各自、每个区块按顺序判断，前一条成立就不看后面。每笔交易都会先模拟（eth_call），模拟失败就不发；
同一条链同一时间只会有一笔交易在等上链。

1. 上一笔还没上链 → 等。上链了、nonce 已经被用掉、或 Flashbots 返回 FAILED／CANCELLED／UNKNOWN 就放行；
   兜底是主网 10 个区块（L2 换算成差不多的时间）
2. 有待存的本金，而且 Aave 能存了（没冻结、存款上限还有空间）→ 存
3. 有债、HF < `EMERGENCY_HF` → 不管价差还在不在，**只买回让 HF 回到 `EMERGENCY_TARGET_HF` 所需的量**（多 5%），不一口气全平；
   按这个价格买回反而会让 HF 更低时才全平。没有池子买得到时会提醒：把稳定币转进合约，或用 `repayFromOwner` 直接拿 WETH 还
4. 有“可用”的池子溢价 ≥ `OPEN_PREMIUM_BPS`，而且已经持续 `CONFIRM_SECONDS` 秒 →
   **先问聚合器**：规模取“健康因子撑得住的量（用溢价的一半估）”和下面的单笔上限中的较小值，报价不到预言机下限就减半，最多 3 次，
   模拟通过就发 `openVia`。聚合器没响应或报价都不够好，才按溢价高低逐个试单一 Uniswap 池子的 `open`，发出一笔就停。
   聚合器可用时，Aerodrome／Velodrome 池子报出的溢价也算数。
   可用 = Aave 的 WETH 没冻结、这种稳定币能存（没冻结、LTV > 0、存款上限有空间），而且池子里至少有 `MIN_POOL_WETH` 颗 WETH（死池不算）。
   每笔最多卖 `MAX_WETH_PER_TX`、Aave 还能借出的 WETH × 95%、这种稳定币还能存的量（换算成 WETH）× 95%，取最小值。
   规模先用“溢价的一半”估算（第一笔就开满），健康因子不够合约会拦截，再退回最保守的估法。
   可用的池子价差还在就继续拿着，不平仓；只有死池或存不进去的池子出现溢价时，照常走第 5 步
5. 有债、某个池子溢价 ≤ `CLOSE_PREMIUM_BPS` → 从 WETH 最便宜、而且合约有足够对应稳定币的池子开始买回。
   单一池子都平不了（例如都被推到价格上限 `NoEdge`）时改用聚合器 `closeVia`；紧急降杠杆和 `exit` 也一样，池子不行就换聚合器

`CLOSE_ONLY=1` 时只做 1、3、5：不存本金、不开仓，只管把仓位平掉。

### 真正要用时

- **机器人要一直开着**。这次第一名在事发后 24 分钟进场，有效窗口大约一小时，笔记本休眠就错过了。
  在 Mac 上用 `caffeinate -i`，或放在不会关机的 Linux 机器上用监管程序运行（见下一节）。
- 现在（2026-10-30）Aave 冻结中，可以先跑 `node start.ts`：部署、授权本金、让机器人等着，解冻后它会自动存入。
  本金存进 Aave 之后也会赚取存款利息。
- 主网默认走 Flashbots Protect（`SEND_RPC_URL_MAINNET`）：不会被抢跑或夹子攻击；会失败的交易不会上链，也不扣 gas；
  但可能等好几个区块才上链，或根本没上。L2 直接发给该链的 RPC。要抢速度可以设置 `PRIORITY_FEE_GWEI`。
- 公共 RPC 偶尔会限流。每条链默认两个公共 RPC，第一个失败自动换第二个；有自己的 RPC（Alchemy、Infura…）就填进 `RPC_URLS_<链>`（逗号分隔，按顺序主备切换）。
- 启动时连不上、或配置没做完的链，全自动模式（`--yes`）每分钟重试，成功就开始看管；一条链出错不影响其他链。

## 24 小时运行（Linux）

在要跑交易的那台机器上：

```bash
git clone https://gitlab.com/aa22396584/aave-oracle-lag-arb.git && cd aave-oracle-lag-arb
bash deploy/install.sh            # 加 --with-op 會一起裝 1Password CLI
~/.local/share/aave-oracle-lag-arb/set-wallet.sh
~/.local/share/aave-oracle-lag-arb/trader.sh start
```

从笔记本装到远程服务器（`host` 换成你的服务器；`-t` 让 `set-wallet.sh` 能用隐藏输入框询问 key）：

```bash
ssh -t host 'git clone https://gitlab.com/aa22396584/aave-oracle-lag-arb.git && cd aave-oracle-lag-arb && bash deploy/install.sh && ~/.local/share/aave-oracle-lag-arb/set-wallet.sh'
ssh host ~/.local/share/aave-oracle-lag-arb/trader.sh start     # 在背景跑，ssh 斷了也繼續
```

### 安装做了什么

`deploy/install.sh`：

- 用 PATH 上的 Node 20 以上。没有或版本太旧时（仅限 Linux x64／arm64）下载固定版本的 Node 22、校验 sha256，只把 `node` 这个二进制文件放进 `APP_DIR`
- `npm ci` 之后用 esbuild 把 `bot/` 打包成单文件 `bot/dist/aave-oracle-lag-arb.mjs`，运行时不需要 `node_modules`。原本没有 `bot/node_modules` 的话，打包完会删掉（小机器的 inode 比较紧）
- 把打包文件、`bot/OracleLagArb.json`、`trader.sh`、`set-wallet.sh`、`set-alerts.sh` 复制进 `APP_DIR`
- `--with-op`：把 1Password CLI 装进 `APP_DIR`（仅限 Linux x64／arm64，需要 `python3` 解压）
- `--bundle-node`：始终把固定版本的 Node 放进 `APP_DIR`，适用于重启后会丢失系统 Node 的机器（例如 Grok Bot 的电脑）
- 机器人在运行的话会重启；没在运行就打印出下一步

需要 `bash`、`git`、`curl`；要下载 Node 时还需要 `sha256sum` 和能解压 `.tar.xz` 的 `tar`。

| | 默认 | 存放内容 |
|---|---|---|
| `APP_DIR` | `~/.local/share/aave-oracle-lag-arb` | 打包好的机器人、`trader.sh` 等脚本、下载的 `node`／`op`、日志 `trader.log`、`state.json`（合约地址）、心跳和检查状态 |
| `ARB_CONFIG_DIR` | `~/.config/aave-oracle-lag-arb` | `env`（钱包和其他配置）、`alerts.env`（webhook）。文件权限 600，目录 700 |

`APP_DIR` 只在安装时使用（`APP_DIR=/opt/arb bash deploy/install.sh`，之后更新也要设成一样的）；装好的脚本自己知道在哪个目录。
`ARB_CONFIG_DIR` 改了的话，每次运行 `set-wallet.sh`、`set-alerts.sh`、`trader.sh`（包括定时任务）都要设成一样的。

### 配置钱包（set-wallet.sh）

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

| 方式 | env 文件里存什么 |
|---|---|
| 输入框、`--from-env` | `KEY=<值>`（私钥或助记词本身） |
| `--env-name` | `KEY_ENV=<名称>`，只有名称。机器重启后，定时任务的环境里没有这个变量的话，`ensure` 会说“this environment doesn't have it”并且不启动 |
| `--op`、输入框粘贴 `op://` | `OP_SERVICE_ACCOUNT_TOKEN` 和 `KEY=op://…`。建议建一个只放这把 key 的保险库，token 只给读取该保险库的权限 |
| `--index`、`--path` | `MNEMONIC_INDEX`／`MNEMONIC_PATH`。单独用时只换地址，key 不变；也可以跟上面的方式一起用 |

- key 不会打印出来，也不会出现在命令参数里。env 文件里原本的其他配置（调参的变量、RPC）会保留，只替换钱包那几行。
- 最后会运行 `trader.sh whoami`（不发交易），打印出地址和每条链的余额。
- 助记词没指定地址时，`whoami` 会失败并列出地址，按提醒用 `--index` 或 `--path` 选一个。全自动模式不猜地址：猜错会把别的钱包的钱存进来，或重启时换到另一个地址。
- keystore 文件每次启动都要输入密码，监管程序在后台运行时没办法输入，所以 24 小时运行请用私钥、助记词或 1Password。
- 不用 env 文件也可以：`trader.sh` 会读取环境里的 `KEY`、`PRIVATE_KEY`、`MNEMONIC`、`KEY_ENV`、`KEY_FILE=<存放 key 的文件路径>`。

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

| 命令 | 做什么 |
|---|---|
| `start` | 在后台运行，关掉终端或 ssh 也继续；机器人退出了会自动重启 |
| `ensure` | 跟 `start` 一样，但没配钱包、或是用 `stop` 停掉的，就静默跳过；沿用上一次的模式 |
| `close-only` | 以只平仓模式重启 |
| `stop` | 停止，仓位保留。之后 `ensure` 不会拉起，要 `start` 才会 |
| `status` | 是否在运行、模式、上次退出的时间和退出码、最后 8 行日志 |
| `logs` | 持续打印日志 |
| `whoami` | 钱包地址和每条链的余额（确认 key 读得到） |
| `check` | 跑一次健康检查，打印 JSON。退出码 0 = 跟上次比没变化，1 = 有变化，其他 = 出错。不用 key（见“告警”） |
| `exit` | 停止，然后每条链平仓、把钱提回钱包。没做完会改成只平仓模式重新启动 |

### 监管程序会做的事

- 用 `start --yes --deposit all` 启动机器人：**钱包里的 USDC／USDT 都会存进合约当本金**（Aave 收得进去的链），ETH 留着付 gas。只平仓模式用 `--deposit 0`。
- 挂掉会自动重启。运行超过 5 分钟才退出的，10 秒后重启；启动后 5 分钟内就退出算一次失败，连续失败 n 次就等 n × 30 秒，最多 5 分钟，不会放弃。
  连续 3 次失败、最后一次在 15 分钟内时，`check` 会报 `trader_crashloop`。
- 用 `stop` 停掉的，`ensure` 不会拉起。机器重启之后没有东西会自动把它拉起来，要等定时任务下一次运行 `ensure`（见“交给 AI agent 跑”）。
- `exit` 没做完（例如价格太贵、稳定币提不出来）时，会改成只平仓模式重新启动，继续看管仓位；之后再运行一次 `exit`。
  `ensure` 会沿用只平仓模式，机器重启之后也一样。
- 日志在 `APP_DIR/trader.log`，超过 20 MB 就复制成 `trader.log.1` 再清空（每次启动前和每 5 分钟检查）；心跳文件写不进去（例如硬盘满）不影响交易。
- 合约地址记在 `APP_DIR/state.json`。这个目录丢了的话重跑 `install.sh` 即可：合约地址会从钱包的交易记录自动找回来，状态文件会重建。

### 更新

```bash
cd aave-oracle-lag-arb && git pull && bash deploy/install.sh     # 在跑的話會重啟
```

安装程序不会动 `ARB_CONFIG_DIR`，钱包和 webhook 配置会保留。

### key 的安全

- **好几个 bot 或 agent 共用的机器（包括 agent 平台分配的电脑），机器人跑起来之后，其他 bot 或 agent 都读得到 key。**
  不管用哪种方式提供钱包，机器人跑起来之后 key 就在那台电脑的进程里。请使用一个专用钱包，只放这个策略要用的资金。
- env 文件权限 600、目录 700。三个脚本都不会把 key 打印出来或放进命令参数。

### macOS

监管程序只支持 Linux（用到 `setsid` 和 `/proc`）。Mac 上在终端运行：

```bash
cd bot && npm install && caffeinate -i node start.ts
```

### 验证过的

2026-10-30 在云端的 Linux x64 VM 上，用没有钱的测试钱包验证过：
- `install.sh`：用系统的 Node 20，以及下载固定版本的 Node 22
- `set-wallet.sh` 从环境变量读取：助记词 → 列出地址 → `--index`；私钥；`--env-name`，环境里有这个变量和没有的情况
- `set-alerts.sh` 的测试 POST：返回 200 成功，返回 404 失败
- `trader.sh` 的 `start`、`status`、`stop`、`ensure`

还没验证：1Password 用真实 token 读 key；Grok Bot 和 Hermes Agent 从头到尾走一遍。

## 交给 AI agent 跑

机器人不绑定特定的 agent：所有操作都是 `deploy/` 里的脚本，能跑 shell 的 agent 都能用。

| 文件 | 用途 |
|---|---|
| `skills/aave-oracle-lag-arb/SKILL.md` | skill（[agentskills.io](https://agentskills.io) 格式）：安装、配置钱包、启动、定时检查、读告警、出场 |
| `.claude/skills/` | 链接到上面那个 skill；用 Claude Code 打开这个 repo 时会读到 |
| `.agents/skills/` | 同上，给 Codex |
| `AGENTS.md` | 给要改代码的 coding agent（Codex、Cursor；Claude Code 通过 CLAUDE.md 读到） |

skill 里写的做法：key 不在普通对话里给，而是用平台的掩码输入变成环境变量，再运行 `set-wallet.sh --from-env`；
启动前给用户看地址和余额、确认一次；`stop`、`close-only`、`exit` 只在用户要求时运行。

### Claude Code／Codex／Cursor

在要跑交易的机器上打开这个 repo，跟它说“在这台机器上配置 oracle-lag 机器人”（set up the oracle-lag bot on this machine）。

想在任何目录都能用，把 skill 复制出去：

```bash
cp -r skills/aave-oracle-lag-arb ~/.claude/skills/    # Claude Code
cp -r skills/aave-oracle-lag-arb ~/.agents/skills/    # Codex
```

### Hermes Agent

```bash
cp -r skills/aave-oracle-lag-arb ~/.hermes/skills/
hermes skills list | grep aave-oracle-lag-arb   # 有沒有讀到；已經開著的對話用 /reload-skills 更新斜線指令
```

Hermes 也能用 `hermes skills install <owner>/<repo>/<路径>` 从 GitHub 安装 skill：镜像是 `akari-sora/aave-oracle-lag-arb`，
skill 路径 `skills/aave-oracle-lag-arb`（未测试）。
装好之后让 Hermes 安装机器人，并配置定时任务每 6 小时运行一次 `trader.sh ensure` 和 `trader.sh check`。

### Grok Bot

最快：打开模板 [https://x.ai/bot/4OryWRBkWbghpXyZytSSm](https://x.ai/bot/4OryWRBkWbghpXyZytSSm)，点 **Add to Grok Bot**。拿到的是你自己的一份 bot，钱包密钥、定时任务和电脑都只属于你。
接着跟它说“set up”和“set wallet”。细节和 persona（要自己建的话）在 [integrations/grok-bot.md](integrations/grok-bot.md)。
它会把机器人装在 Grok Bot 的电脑上，
用带掩码的密钥卡片收 key，定时任务每 6 小时运行 `ensure` 和 `check`。另外建一个 webhook 触发的定时任务，再用 `set-alerts.sh` 接上，就能收实时告警。

同一个 Grok 账号的所有 bot 共用这台电脑（[官方](https://docs.x.ai/grok-bot/security-faq)：“Treat a login or file on the computer as available to every Bot that user runs”）。

### 其他 agent 或 cron

定时任务只要按顺序运行这两个（每 6 小时就够，机器人自己每个区块都在判断）：

```bash
APP=~/.local/share/aave-oracle-lag-arb
$APP/trader.sh ensure     # 沒在跑就叫起來；沒設錢包或用 stop 停掉的就跳過
$APP/trader.sh check      # 印一個 JSON 物件
```

`ensure` 打印出 `started` 代表机器人之前挂了或机器重启过，值得通知一声。

| `check` 退出码 | 意思 | 怎么做 |
|---|---|---|
| 0 | 跟上次检查比没有变化 | 不用通知 |
| 1 | 有新出现或消失的项目 | 用一两句话汇报 `new` 和 `resolved` |
| 其他 | 出错 | 汇报一次错误消息的前几行，不要每次都报 |

```json
{"changed": true, "findings": [{"level": "warning", "code": "premium_open:base", "kind": "condition", "message": "…"}], "new": ["premium_open:base"], "resolved": []}
```

第一次运行只在有 warning／critical 时算变化。上一轮的状态记在 `APP_DIR/check-state.json`。code 的含义见“告警”。
要实时通知的话，用 `set-alerts.sh` 配置一个 webhook（payload 也见“告警”）。

只用 cron 的话：

```
@reboot      $HOME/.local/share/aave-oracle-lag-arb/trader.sh ensure
0 */6 * * *  $HOME/.local/share/aave-oracle-lag-arb/trader.sh ensure
```

cron 自己不会发消息：搭配 webhook，或把 `trader.sh check` 包在自己的脚本里，退出码 1 时通知你。
cron 的 PATH 很短；`node` 不在 `/usr/bin` 的话（例如用 nvm 装的），在 crontab 最上面设置 `PATH=`。

## 告警

`check` 和 webhook 用同一份发现清单。code 后面接 `:链`（例如 `premium_open:arbitrum`），不同链出事算不同的消息。

| code | level | 触发条件 |
|---|---|---|
| `premium_open:<链>` | warning | 最贵的池子溢价 ≥ `OPEN_PREMIUM_BPS`（Aave 冻结时消息会注明借不到）。掉到阈值 − 1%（阈值低于 2% 时是一半）以下才算结束 |
| `hf_low:<链>` | critical | 有债而且 HF < `EMERGENCY_HF` |
| `bot_not_running:<链>` | warning | 有机会或有持仓，但这台机器上这条链的机器人一分钟内没有心跳（机器人旁边的 `heartbeat-<链>.json`：从源码运行在 `bot/`，监管程序在 `APP_DIR`） |
| `action_failing:<链>` | warning | 机器人连续 `ACTION_FAIL_ALERT`（5）次动作未成功：模拟失败、交易失败或未上链。“价格到上限先等”不算 |
| `gas_low:<链>` | warning | 有仓位，钱包的 ETH 低于主网 0.02／L2 0.002（紧急降杠杆会发不出去） |
| `trader_crashloop` | critical | `trader.sh` 底下的机器人连续 3 次启动后 5 分钟内就退出，最后一次在 15 分钟内（例如 1Password 读不到 key） |
| `rpc_error:<链>` | warning | 读不到这条链的数据（只有 `check` 会出现） |
| `position_open:<链>` | info | 持仓中 |
| `aave_frozen:<链>` | info | 这条链 Aave V3 的 WETH 冻结中 |

### 定时查询

`node start.ts check --json` 打印出发现清单，有 warning／critical 时退出码 1。消息默认是繁体中文（设置 `BOT_LANG=en` 可切换为英文）：

```json
[{"level": "warning", "code": "premium_open:mainnet", "kind": "condition", "message": "Ethereum Uniswap USDC 0.05% 的 ETH 比 Aave 預言機貴 +9.73%"}]
```

**只报变化**：`node start.ts check --json --state <文件>` 记住上一轮的 code，有新出现或消失的项目才返回退出码 1，输出
`{"changed", "findings", "new", "resolved"}`；第一次运行只在有 warning／critical 时算变化。定时任务用这个，没变化就不用通知。
`trader.sh check` 就是这个命令，状态文件是 `APP_DIR/check-state.json`。

### 推送

`watch` 或机器人在运行的时候，设置了 `ALERT_WEBHOOK_URL`（和 `ALERT_WEBHOOK_HEADER`，例如 `Authorization: Bearer …`），
某条链的清单有变化才 POST 一次（第一轮只在有 warning／critical 时发）：

```json
{"source": "aave-u-eth", "host": "…", "chain": "base", "time": "…", "block": "53272934", "findings": [...], "new": ["premium_open:base"], "resolved": []}
```

`aave_frozen:<链>` 出现在 `resolved` 就代表那条链的 Aave 解冻了。webhook 不等响应（超时 10 秒），不会拖慢交易判断。

### 配置 webhook（set-alerts.sh）

用监管程序运行时，URL 和请求头存在 `ARB_CONFIG_DIR/alerts.env`（权限 600），重跑安装程序不会覆盖。

```bash
$APP/set-alerts.sh https://example.com/hook                              # 用不顯示的輸入框問標頭或 token
$APP/set-alerts.sh https://example.com/hook --header-from-env ALERT_KEY  # 從環境變數拿（例如 agent 平台注入的秘密）
$APP/set-alerts.sh https://example.com/hook --no-auth                    # 網址本身就帶著秘密
$APP/set-alerts.sh --off                                                 # 拿掉 webhook
```

- 只给 token 时会变成 `Authorization: Bearer <token>`；带冒号的就当整行请求头用。
- 保存之后发一次测试 POST，格式跟机器人发的一样、只是没有发现项：
  `{"source":"aave-u-eth","test":true,"findings":[],"new":[],"resolved":[]}`。打印出 HTTP 状态码，不是 2xx 就退出码 1（配置依然保留，改好再跑一次，或 `--off`）。
- 请求头通过文件描述符传给 curl，不会出现在命令参数里。
- 机器人在运行的话会重启，让新配置生效。

## 配置

全部都有默认值。从源码运行时，把 `bot/.env.example` 复制成 `bot/.env`，程序启动时会自动读取（已经设在环境变量里的优先）。
用监管程序运行时，把要改的变量加进 `ARB_CONFIG_DIR/env`（`set-wallet.sh` 不会动它们），再执行 `trader.sh stop && trader.sh start`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CHAINS` | `mainnet,arbitrum,base,optimism` | 跑哪几条链 |
| `RPC_URLS_<链>` | 每条链两个公共 RPC（见 `bot/core.ts`） | 读数据、估 gas 用，逗号分隔、按顺序主备切换。`<链>` 是 `MAINNET`／`ARBITRUM`／`BASE`／`OPTIMISM`；只给一个用 `RPC_URL_<链>` |
| `SEND_RPC_URL_<链>` | 主网 `https://rpc.flashbots.net/fast`，L2 同 `RPC_URL_<链>` | 发交易用 |
| `PRIORITY_FEE_GWEI` | 自动估 | 给打包者的小费 |
| `GAS_LIMIT_MULT` | 1.25 | gas 上限 = 估计值 × 这个（估完到上链之间，flash swap 可能多跨几个 tick） |
| `MAX_FEE_BASE_MULT` | 2 | maxFeePerGas = base fee × 这个 + 小费 |
| `OPEN_PREMIUM_BPS` | 300 | 溢价 ≥ 3% 才开 |
| `CONFIRM_SECONDS` | 15 | 溢价要持续这么多秒都在阈值以上才开，过滤单笔大单造成、下个区块就被套平的瞬间跳动（等待中的消息每 `LOG_MS` 打印一次） |
| `MIN_EDGE_BPS` | 50 | 卖到溢价剩 0.5% 就停 |
| `TARGET_HF` | 1.3 | 开仓后健康因子下限。至少 1.05（低于“清算阈值 ÷ LTV”Aave 会拦截借款），启动时检查 |
| `MAX_WETH_PER_TX` | 0 | 单笔最多卖多少 WETH，0 = 只受 Aave 可借量限制 |
| `MIN_WETH_PER_TX` | 0.5 | 单笔少于这个量就不开 |
| `CLOSE_PREMIUM_BPS` | 30 | 溢价 ≤ 0.3% 就买回 |
| `EMERGENCY_HF` | 1.1 | 低于这个值就不挑价格先降杠杆 |
| `EMERGENCY_TARGET_HF` | 同 `TARGET_HF` | 降杠杆买回到 HF 回到这个值就停 |
| `MIN_POOL_WETH` | 5 | 池子里少于这么多 WETH 就当死池 |
| `CLOSE_ONLY` | — | `1` = 只平仓、不开仓、不存本金 |
| `ACTION_FAIL_ALERT` | 5 | 连续失败几次发 `action_failing` |
| `EMERGENCY_MAX_PREMIUM_BPS` | 1000 | 降杠杆时最多比预言机贵 10% 也买 |
| `EXIT_MAX_PREMIUM_BPS` | 300 | `exit` 时最多比预言机贵 3% 也买 |
| `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_HEADER` | — | 告警推送（见“告警”） |
| `AGGREGATOR` | `kyber` | `off` 关掉聚合器路径，只用单一 Uniswap 池子 |
| `AGG_SLIPPAGE_BPS` | 100 | 给聚合器的滑点容忍度；真正的价格保护是合约里的预言机下限 |
| `WS_URL_<链>` | publicnode 的 `wss://` | 订阅新区块，一出来就判断（比轮询快）；`off` 关掉。换了 `RPC_URL(S)_<链>` 又没给这个时不订阅 |
| `POLL_MS` | 3000 | 轮询间隔（WS 断线时的兜底） |
| `MIN_TICK_MS` | 500 | 两次判断至少隔多久（Arbitrum 每秒 4 个区块） |
| `LOG_MS` | 30000 | 没事的时候多久打印一行 |
| `MNEMONIC_INDEX` / `MNEMONIC_PATH` | — | 助记词直接指定地址，不扫描 |
| `ARB_ADDRESS_<链>` | `state.json` | 指定合约地址 |
| `BOT_LANG` | — | `en` = 消息用英文；其他 = 繁体中文 |

## 测试

```bash
forge test -vv
```

- 每条链都 fork 真实的链，先用 ACL 权限模拟 DAO 解冻 Aave（稳定币的 LTV 还是 0 就设回 75%），再用真实的 Uniswap 池子制造价差。
- RPC 用 `ETH_RPC_URL`、`ARB_RPC_URL`、`BASE_RPC_URL`、`OP_RPC_URL`；固定区块用 `FORK_BLOCK`、`ARB_FORK_BLOCK`、`BASE_FORK_BLOCK`、`OP_FORK_BLOCK`，
  没设就用最新区块。
- publicnode 的主网、Arbitrum、Optimism 只保留最近约 128 个区块的状态（Arbitrum 只有约 30 秒），所以 L2 测试默认用官方 RPC。
  要固定区块重跑，得用带 archive 的 RPC。
- 四条链一起跑大约 2～3 分钟，大部分时间花在从 RPC 拉取状态。

2026-10-30 的结果：61 个测试全部通过（主网 19、每条 L2 各 14）。fork 的区块不同，盈亏数字会差一点。

| 链（池子） | 溢价 10% 时的盈利（本金 100k USDC） |
|---|---|
| 主网（USDC 0.05%） | +13,974 USDC |
| Arbitrum（USDC 0.05%） | +14,721 USDC |
| Base（USDC 0.05%） | +13,681 USDC |
| Optimism（USDC 0.3%，池子比较浅） | +12,925 USDC |

机器人（TypeScript）用 `cd bot && npm run typecheck`（`tsc --strict`）检查类型。

| 测试 | 内容 |
|---|---|
| `test_profitWhenUniswapConvergesDown` | 溢价 10% → open → 拿一天 → Uniswap 回到预言机价 → close，每条链都测 |
| `test_open_revertsWithoutPremium` | 没价差就 `NoEdge` |
| `test_open_sizingEdgeSellsMore` | 估规模用溢价的一半时第一笔卖更多（67.6 → 72.5 WETH），HF 照样达标，每条链都测 |
| `test_close_usesIdleStableFirst` | 合约手里闲置的稳定币平仓时先用，不够才从 Aave 提，每条链都测 |
| `test_flashCallbacks_rejectOutsiders` / `…rejectForeignFlashLoan` | 聚合器路径的 flash loan 回调：不是 Aave、不是自己发起、不在进行中的一律拒绝；别人拿 Aave flash loan 指定这个合约当收款人也会失败，每条链都测 |
| `test_openVia_guards` / `…revertsBelowEdge` / `…revertsWhenTooBig` | router 不在白名单、不是 owner、成交价低于“预言机 × 1.005”、借太多都会整笔 revert，每条链都测 |
| `test_openVia_thenCloseVia` | 用 router（测试用 Uniswap SwapRouter02）卖 20 WETH 开仓、买回平仓：债务归零、授权归零、赚钱；上限太低时 `closeVia` 拒绝多付，每条链都测 |
| `test_crossStable_closesInChunks`（主网） | 仓位一部分在 USDC 池、大部分在 USDT 池：USDC 付不起全部债时只平一部分、不 revert，轮流平到债务归零，总资产 > 本金 |
| `test_oracleUpByHfMinusOne_liquidatable` | 预言机涨 (HF − 1) 就会被清算 |
| `test_onlyOwner` / `test_callbackOnlyDuringOwnSwap` / `test_rejectsPoolNotFromFactory` | 权限 |
| `test_profitOnWethToken0Pool`（主网） | WETH/USDT 0.3% 池（WETH 是 token0），溢价 5% 一样能开、能平，赚 6,769 USDT |
| `test_open_stopsAtPriceLimit`（主网） | 溢价 1%、本金大：卖到价差剩 0.5%（扣手续费后）就停 |
| `test_open_respectsMaxWethIn`（主网） | 单笔上限有效 |
| `test_oracleCatchesUp_noProfit`（主网） | 预言机涨 10% 追平：平仓亏 166 USDC |

### 改了合约之后

`start.ts` 部署的是 `bot/OracleLagArb.json`，里面记了 `src/` 的 sha256；源码改过却没重新导出，它会拒绝部署。

```bash
forge build && node bot/export-artifact.ts
```

### 手动操作（Foundry）

```bash
forge script script/Deploy.s.sol --rpc-url $ETH_RPC_URL --account <keystore 名稱> --broadcast
cast send $ARB "open(address,uint256,uint256,uint256,uint256)" <pool> 50 50 1300000000000000000 0 --account <keystore>
cast send $ARB "close(address,uint256,uint256)" <pool> 30 0 --account <keystore>
cast send $ARB "withdraw(address,uint256,address)" $USDC $(cast max-uint) <你的地址> --account <keystore>
cast call $ARB "premiumBps(address)(int256)" <pool>
```

`Deploy.s.sol` 默认是主网地址；其他链用 `AAVE_ADDRESSES_PROVIDER`、`WETH`、`UNI_V3_FACTORY` 覆盖（地址见 `bot/core.ts` 的链配置）。
手里有 WETH 也可以不经过 Uniswap，直接用 `repayFromOwner(amount)` 还债（要先 approve WETH 给合约）。
资产在 LTV = 0 时存进 Aave 不会自动算作抵押品，LTV 恢复后用 `setCollateral(asset, true)` 开启。

## 别人怎么做的

2026-10-30 汇总。时间是 UTC；标“单一来源”的只有一个出处，其余至少两个独立信源或一手数据（链上记录、Aave 社区提案）。

**这次事件**

- 20:24 Binance 热钱包开始被盗转；20:34 黑客把 50M USDT 经 UniswapX 换成 20,940 ETH，溢价从这笔开始
  （[Decrypt](https://decrypt.co/382194/binance-hack-exit-ramps-defi-exchange-ethereum)）。
- 溢价出现在 Uniswap V3 WETH/USDT 0.3% 和 ETH/USDC 0.05%（单一来源）。约 21:00 时 Uniswap 约 2,700，Chainlink 约 2,250
  （[The Defiant](https://thedefiant.io/news/markets/eth-trades-at-20-premium-on-uniswap-versus-binance)）。
- 第一名事先已经在 Aave 主网存好约 $37M USDC，事发后 24 分钟进场，**手动分 18 笔**，每笔 300～1,000 ETH，走 DEX 和聚合器，
  大部分在 2 小时内平仓。前十名合计约 $6.36M，共 206 笔卖单，均价高于预言机约 10%。没有任何信源提到闪电贷或原子交易
  （单一来源：[0xNaiXi](https://x.com/0xNaiXi/status/2115967318274789609)）。
- 黑客自己也在 20:57～21:01 存 60M USDT、从 Aave 主网借走 19,762 WETH，跟套利者抢同一池 WETH
  （[TechFlow](https://www.techflowpost.com/en-US/article/34992)、[Cointelegraph](https://cointelegraph.com/news/binance-linked-wallet-faces-possible-exploit-blockchain-researcher-warns)）。
- 21:30 以后价差缩到 3～5%（单一来源）。21:42 Guardian 开始冻结（单一来源）。**窗口是价差收敛关掉的，不是冻结**。
- 没找到 Arbitrum、Base、OP 出现溢价的证据；也没找到 Spark、Morpho、Compound 被拿来做这个套利的证据。

**以前的类似事件**

- LUNA（2022-05）：Chainlink 的 minAnswer 让预言机卡在 $0.107，市价 $0.01，有人在 Venus、Blizz 用 LUNA 抵押把其他资产借光
  （[rekt](https://rekt.news/venus-blizz-rekt)）。
- CRV（2022-11）：Mango Markets 的攻击者在 Aave 存 USDC、借 CRV 抛售做空，CRV 被轧空、仓位被清算。借币卖出就是做空，那个币一涨就爆仓
  （[CoinDesk](https://coindesk.com/markets/2022/11/22/mango-exploiter-gets-liquidated-after-roiling-aave-using-20m-of-borrowed-curve-tokens)）。
- Kelp（2026-04）：攻击者 46 分钟内从 Aave 借走 82,650 WETH，WETH 可用流动性 1.4 小时内从约 $689M 掉到 $1.5M
  （[Glassnode](https://research.glassnode.com/anatomy-of-a-liquidity-freeze/)）。可借量要纳入单笔上限。
- CAPO（2026-03）：Aave 的 wstETH 预言机参数错配、报价低估约 2.85%，约 $27M 被误清算
  （[The Block](https://www.theblock.co/post/393121)）。

**这个项目因此做的**：价差持续 `CONFIRM_SECONDS` 才开仓；单笔受 Aave 可借量和 borrow cap 限制；每个区块重新评估、分批加仓；
价格下限保证最差成交价；收敛后自动买回；冻结时不开仓、解冻后自动存本金。没做的：交易所对冲、反方向、其他借贷协议。

## 演练记录（2026-10-30，anvil fork）

**实操画面（主网，当前代码，就是上面的 GIF）**：Aave 冻结 → 部署、等待；解冻 → 自动存入 100,000 USDC；
Uniswap USDC 0.05% 推到 +10.09% → 满 15 秒后分两笔开仓（73.02 + 5.63 WETH；健康因子 1.337，再到 1.303）；价格推回预言机 →
在两个池子买回到各自触及 +0.3% 上限；`exit` 买回剩下的 21.85 WETH、全部提取：**100,000 → 116,484.18 USDC**。

**单链（主网）**：从 Aave 真实冻结的状态开始，`node start.ts --yes --deposit 100000`：
部署 → 待存 → 模拟解冻后自动存入 → Uniswap 推高 10%，分 3 笔开仓 → 回到预言机价后平仓：**100,000 → 115,979 USDC**。
再开一次仓后停掉机器人，用**助记词**运行 `exit --yes`，一轮平仓、提取 → 钱包 **134,537 USDC**。

**多链（主网 + Base 同时跑）**：

1. 两条链各自部署合约、授权，本金记为待存
2. 只有主网解冻 → 主网自动存入；Base 推高 10% 但仍冻结 → 推送 `premium_open:base`（注明借不到），不开仓
3. Base 解冻 → 自动存入 → 溢价已经持续超过 `CONFIRM_SECONDS`，立刻分 3 笔开仓
4. Base 回到预言机价 → 在 USDC 0.3% 池一笔平仓：**100,000 → 116,262 USDC**
5. 再开一次仓后用助记词 `exit --yes`：主网提取 100,000.05 USDC；Base 一轮平仓、提取 **134,857 USDC**

**审查修正后（Optimism，USDC + USDT 跨稳定币）**：

1. 机器人在 Aave 冻结时启动 → 解冻后自动存入 100,000 USDC
2. USDT 池（浅）推高 10% → 卖 12.3 WETH 就被价格下限拦住；USDC 池推高 10% → 单笔上限 25 WETH：25 + 25 + 25 + 3，HF 1.301 停
3. 价格收敛 → 买回把池子推到 +0.3% 上限时“先等”，价格回来再买，分几轮平到债务归零：**100,000 → 116,198（USDC + USDT）**
4. 再开仓后把 Aave 预言机调高 25%（模拟预言机往上追）→ HF 1.04，发 `hf_low` → 算出要买回 55.6 WETH，跳过只剩零头的 USDT 池，
   在 USDC 池买回 30.6 WETH → **HF 回到 1.326，还保留 48 WETH 仓位**（不是全部砍掉）
5. 删掉 `state.json`，助记词没指定地址 → 全自动模式拒绝；指定 `MNEMONIC_INDEX=0` 运行 `exit` → **从钱包交易记录找回合约**，平仓、提取
6. 跨稳定币的 `exit`：先用 USDT 那轮、再一次在 USDC 池买回剩下的 85.7 WETH，两轮就出场（修正前同样情况跑了 13 轮）

**聚合器路径（Base，用真实的 KyberSwap 路由）**：DEX 价格不动，把 Aave 预言机调低 10%（DEX 看起来贵 11%），让 KyberSwap 按真实链上状态算出的路由能在 fork 上运行：

1. 部署、自动把 KyberSwap router 加进白名单、存入 100,000 USDC
2. 前几次经聚合器开仓的模拟超时（fork 第一次碰到路由经过的合约要从远端拉取），机器人改走 Uniswap 池子卖 81.08 WETH；
   下一个区块起聚合器模拟通过，**经 KyberSwap 开仓** 6.64 + 0.59 WETH（对上 Aave 的债 88.31 WETH），HF 1.300 停
3. 预言机调回真实价格后，用 KyberSwap 的稳定币 → WETH 路由发 **`closeVia`**：买回 30 WETH、付 67,609 USDC，债 88.31 → 58.25，给 router 的授权清零
4. `exit` 一轮平掉剩下的、全部提取：钱包 99,697 USDC。这次的“价差”是把预言机调低再调回造成的（等于预言机往上追），本来就赚不到钱，只付手续费；
   这次演练的是聚合器路径的机制，盈利场景看上面几段

注意：经聚合器开仓的 gas 比单一池子多很多（这次 3.1M 对 0.75M），主网 gas 贵的时候成本差距明显；`MIN_WETH_PER_TX` 还没把这个算进去。
平仓先用单一池子，是因为 `closeVia` 要多付 flash loan 手续费 0.05%。KyberSwap 被限流（HTTP 429）时，那条链 30 秒内改走单一池子。

没演练过：Flashbots Protect 在主网上的实际打包上链（KyberSwap 路由的期限有按我们给的 10 分钟写进 calldata，2026-10-30 验证过）、
真实事件中 KyberSwap 的报价和成交、Aerodrome／Velodrome 池子真的出现溢价的情况、Arbitrum 上的机器人（只有合约 fork 测试和只读监控）。

## 开源协议

AGPL-3.0-only，见 [LICENSE](LICENSE)。可以使用、修改、分享；分发修改后的版本，或通过网络提供给别人使用时，要用同一个协议公开源码。

这不是投资建议，使用风险自负；软件未经审计。完整内容见[免责声明](DISCLAIMER.zh-CN.md)。
