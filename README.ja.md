# aave-oracle-lag-arb

Uniswap 上の ETH 価格が Aave の Chainlink オラクル価格を大きく上回った際に、Aave からオラクル価格で WETH を借入し、DEX で売却して、価格差が解消されたら買い戻すボットおよびスマートコントラクトです。

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · 日本語 · [한국어](README.ko.md)

公式リポジトリ・Issue・リリース: https://gitlab.com/aa22396584/aave-oracle-lag-arb

## 概要

- Solidity コントラクト `OracleLagArb` は、「ステーブルコインを預け入れ、オラクル価格で WETH を借入し、Uniswap で売却して再度預け入れる」という一連の操作を 1 回のフラッシュスワップ・トランザクションにまとめます。最低売却価格はオンチェーンでオラクル価格と照合されます。
- TypeScript 製ボットが Ethereum、Arbitrum、Base、Optimism を毎ブロック監視します。プレミアムが持続している場合のみポジションを建て、プレミアムが消えたら買い戻し、ヘルスファクターが低下した際は自動でデレバレッジします。
- Linux 用スーパーバイザーとセットアップスクリプトにより、ヘルスチェックと Webhook アラート付きで 24/7 稼働できます。
- エージェントスキルにより、Claude Code、Codex、Hermes Agent、Grok Bot などの AI エージェントにインストールと監視を任せることができます。

**リスク警告: これはレバレッジをかけた ETH のショートポジションであり、無リスクのアービトラージではありません。ETH が大幅に上昇すればポジションは清算されます。また、Aave はいつでも市場を凍結する可能性があります。利用前に[免責事項](DISCLAIMER.ja.md)をお読みください。**

![Ethereum メインネットフォークでのリハーサル](docs/demo.gif)

*現在のコードを用いたローカルの Ethereum メインネット anvil フォークでのリハーサル: Aave の凍結が解除され、Uniswap 上の ETH がオラクルより 10% 高騰するとボットがポジションをオープンし、価格収束後にクローズして全額出金（100,000 → 116,484 USDC）。イベントはシミュレーションであり時間も圧縮されています。実際の取引ではありません。*

CLI のメッセージはデフォルトで繁体字中国語ですが、`BOT_LANG=en` で英語に切り替えられます。コード内のコメントは繁体字中国語です。

## 背景

2026-10-29、Binance のホットウォレットから資金が流出し、Binance は出金を一時停止しました。取引所内の ETH を引き出せなくなったため、一時的に Uniswap 上の ETH 価格が他の市場より 10%–30% 高い水準で取引されました。
Aave は取引所価格に追随する Chainlink オラクルで ETH を評価するため、Aave 上では安い価格のまま ETH を借入できる状態が続きました。
当時、手動で行われていた手順は以下の通りです。

1. Aave にステーブルコインを預け入れる（担保にする）
2. オラクルの安い価格で ETH を借入する
3. Uniswap の高い価格で ETH を売却し、ステーブルコインを受け取る
4. そのステーブルコインを再び Aave に預け入れ、ステップ 2 に戻って繰り返す
5. Uniswap の価格が戻ったら ETH を買い戻し、借入債務をすべて返済する

最も利益を上げたアドレスは、12,289 ETH を約 $2,580 で売却し、12,314 ETH を買い戻す（約 $2,297, 利益約 $3.47M）ことで大きな収益を上げました
（[0xNaiXi](https://x.com/0xNaiXi/status/2115967318274789609)、[Chaincatcher](https://www.chaincatcher.com/en/article/2300192) による報道）。
実際に他のトレーダーがどのように取引したかについては、[他のトレーダーの手法](#他のトレーダーの手法)を参照してください。

## 仕組み

![仕組み](docs/diagram.png)

`src/OracleLagArb.sol` は Uniswap V3 のフラッシュスワップを利用し、上記のステップ 2 から 4 を **1 回のトランザクション**に圧縮します。

```
open(pool, minEdgeBps, targetHf, maxWethIn)
  Uniswap sends stablecoins to the contract ──► contract deposits them on Aave ──► borrows WETH at the oracle price ──► pays WETH back to Uniswap

close(pool, maxPremiumBps, maxWethOut)
  Uniswap sends WETH to the contract ──► contract repays its WETH debt on Aave ──► withdraws stablecoins ──► pays them back to Uniswap
```

- **売却を止める価格ライン**: 売却時には Uniswap の `sqrtPriceLimitX96` を「オラクル価格 × (1 + minEdgeBps)」に設定します。
  Uniswap の価格がこのラインまで押し下げられた時点でスワップが止まるため、すべての WETH は必ずオラクル価格より `minEdgeBps` 以上高い価格で売却されます。
  同時に競合するトランザクションがあった場合は売却量が減るだけで、不利な価格で約定することはありません。
- **売却量の計算**: 売却後のヘルスファクター目標値 `targetHf` によって決まります。ステーブルコイン担保のみ・WETH 借入のみの場合、以下の式が成り立ちます。

  ```
  HF = (C·lt + V·(1+edge)·ltS) / (D + V) ≥ H   ⇒   V ≤ (C·lt − H·D) / (H − (1+edge)·ltS)
  ```

  C と D は既存の担保額と借入額、V は今回借入する WETH の評価額（オラクル価格基準）、lt と ltS は清算閾値（Liquidation Threshold）です。
  この計算式はすべての WETH が下限価格ちょうどで売却される最悪ケースを前提としています。実際の約定価格はそれより良くなるため、オープン後のヘルスファクターは `targetHf` を上回ります
  （テストでは 1.3 に設定し、実際は 1.37 になりました）。ボットは次のブロックで HF が目標値付近になるまでポジションを追加します。
- **買い戻し**: `close` は Uniswap 価格が「オラクル価格 × (1 + maxPremiumBps)」以下の間だけ買い戻しを行い、それを超えると停止します。ポジションが大きい場合、買い戻し自体が価格を押し上げるため、複数回のトランザクションに分かれることがあります。
- **ポジションの所有権はコントラクトにあります**（Aave 上のユーザーはコントラクトアドレスになります）。操作できるのはデプロイヤー（オーナー）のみです。
  Uniswap のコールバックは現在スワップ中のプールからの呼び出しのみを受け付け、プールアドレスは Uniswap ファクトリーで検証されます。
- ステーブルコインはプールに従います。WETH/USDC プールでオープンすれば担保は USDC になり、WETH/USDT プールでオープンすれば USDT になります。
  `close` は Aave からステーブルコインを引き出して Uniswap に支払うため、同じステーブルコインのプールを指定する必要があります。
- チェーンごとに個別のコントラクトと元本を持ちます。ボットは全チェーンを同時に監視します。

**アグリゲーター経路**（`openVia` / `closeVia`）: 単一の Uniswap プールではサイズを吸収しきれない場合、ボットは KyberSwap に最適ルートを問い合わせ、Uniswap V3/V4、Aerodrome/Velodrome、Curve、マーケットメーカーのクオートにまたがって売却します。オープン時は Aave のフラッシュローンを mode 2（返済不要で、そのまま手数料なしの変動金利借入に切り替わるモード）で実行して WETH を借入し、アグリゲーターでステーブルコインにスワップして Aave に預け入れます。クローズ時は WETH のフラッシュローンでまず借入債務を返済し、引き出したステーブルコインをアグリゲーター経由で WETH に戻してフラッシュローン（手数料 0.05%）を返済します。
安全対策は直接のフラッシュスワップと同様に厳格です。
- フラッシュローンのコールバックは、Aave から呼び出され、このコントラクト自身が開始し、現在処理中のものだけを受け付けます。第三者がこのコントラクトを受取人に指定してフラッシュローンを実行しても、トランザクション全体が失敗します。
- オーナーがアグリゲーターのルーターをホワイトリストに登録する必要があります（`setRouter`、`node start.ts` は KyberSwap を自動で追加します）。
- 各 approve はそのトランザクションで売却する数量のみを許可し、処理後にゼロへリセットされます。
- 約定結果はオンチェーンでオラクル価格と照合されます。オープン時は最低でも「WETH × オラクル価格 × (1 + minEdge)」以上のステーブルコインを受け取る必要があり、クローズ時は最大でも「(WETH + 手数料) × オラクル価格 × (1 + maxPremium)」以下の支払いしか認めません。
  コントラクトは自身の残高変化を直接計測し、アグリゲーターが返す数値は信用しません。

## 損益の条件

このポジションは**ステーブルコインを担保にした WETH の借入であり、実質的に ETH のショートポジション**です。無リスクのアービトラージではありません。

| 価格差の解消パターン | 結果 |
|---|---|
| Uniswap 価格がオラクル価格まで下がる（取引所が出金を再開し、安い ETH が流入する） | スプレッドが利益になります。テスト結果: 元本 100k USDC、10% プレミアムでメインネットは **+14,593 USDC** |
| オラクル価格が上昇して Uniswap に追いつく | 売った価格と同じ価格で買い戻すため利益はゼロ、往復 2 回分のスワップ手数料が損失になります。テスト結果: **−166 USDC** |
| 市場全体で ETH が急騰する | 損失が発生し、大幅に上昇すると清算されます |

- **清算ライン**: ヘルスファクターはオラクルの ETH 価格に反比例します。オープン後の HF が h の場合、オラクル価格が (h − 1) 上昇した時点で清算対象になります。
  HF 1.37 であれば、オラクル価格が 37% 上昇するまで耐えられます。
- **ヘッジ**: 真のアービトラージにするには、取引所（ETH が安い側）で同量の ETH 現物を買うか、無期限先物（Perpetual）でロングを建てます。
  本プロジェクトには取引所との連携機能はありません。
- **Aave による市場凍結**: 今回のイベントでは、Aave の Guardian が 16 チェーンの V3 と 4 チェーンの V4 を同時に凍結したため、複数チェーンに分散しても凍結リスクは回避できません。凍結中は `open` が失敗しますが、返済と出金は引き続き可能です。
  2026-10-30 時点で、メインネット、Arbitrum、Base、Optimism の WETH、USDC、USDT はすべて凍結されており、LTV = 0 となっています。
- **凍結後にステーブルコインが引き出せなくなる可能性**: 凍結後に預金者が資金を引き揚げた結果、メインネット V3 の USDC 利用率（Utilization）は 97.8% に達し、100% に張り付いた市場もありました。
  流動性が枯渇すると、誰かが返済するまで出金できなくなります。プロトコル外にも一定の ETH やステーブルコインを残しておいてください。
- **借入金利**: 全員が一斉に WETH を借入すると、利用率が slope2 領域に跳ね上がり、変動金利が非常に高くなります。ポジションを長く保有するほど金利コストがかさみます。
- **フロントラン**: `open` はパブリックなアービトラージ・トランザクションです。メインネットではデフォルトで Flashbots Protect を経由します。価格制限（Price Limit）は最悪約定価格を保証するものであり、約定そのものを保証するものではありません。

## 対応環境

| | 対応 | 非対応 |
|---|---|---|
| チェーン | Ethereum mainnet, Arbitrum, Base, Optimism | その他のチェーン（コントラクトはデプロイ可能ですがボットにアドレステーブルがありません）、非 EVM チェーン |
| レンディング | Aave V3 | Aave V4、Compound、Morpho、Spark（インターフェースが異なるか未テスト） |
| DEX / アグリゲーター | Uniswap V3（コントラクトからの直接フラッシュスワップ）、KyberSwap アグリゲーター経由: Uniswap V3/V4、Aerodrome/Velodrome、Curve、マーケットメーカーのクオート、Aerodrome/Velodrome Slipstream（Base、OP）でのプレミアム検知 | Uniswap V4 および Curve 単体でのプレミアム検知、CEX（中央集権型取引所） |
| トークン | USDC/USDT を担保にした WETH の借入（Base の Aave には USDT がありません） | その他のトークン、逆方向の取引（DEX がオラクルより安いケース） |

## ファイル構成

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

## ソースコードからの実行

このセクションでは、チェックアウトしたリポジトリから直接ボットを実行します（OS 不問）。Linux で 24/7 常時稼働させる場合は、[常時稼働デプロイ (Linux)](#常時稼働デプロイ-linux) を参照してください。

`.ts` ファイルを直接実行できる Node 22.18+（または 23.6+）が必要です。初回のみ依存パッケージをインストールします。

```bash
cd bot && npm install
```

### コマンド 1 つで起動

```bash
cd bot
caffeinate -i node start.ts      # caffeinate keeps a Mac awake; elsewhere just run node start.ts
```

起動すると以下のステップを順に進め、各ステップの前に確認プロンプトを表示します。

1. ウォレットの入力を求めます（次のセクションを参照）
2. ウォレットにガス代用の ETH と USDC/USDT がある各チェーンで、コントラクトをデプロイし（メインネットは約 0.003 ETH、L2 はごくわずか）、預け入れる元本の額を尋ねます。Aave が凍結中で預け入れできない場合は、今のうちに approve だけ済ませ、Aave の凍結が解除されたブロックでボットが自動的に預け入れます
3. ETH またはステーブルコインがないチェーンは監視とアラート送信のみを行います。すでにコントラクトが存在する場合はポジションの監視も継続します（例えばポジション保有中にガス代が切れても、HF 低下のアラートは通知されますが、トランザクションの送信は行いません）
4. 各チェーンで毎ブロック自動判定しながら取引を開始します（判定ルールは後述）。Ctrl+C で停止すると、ポジションは維持されたまま終了します

コントラクトアドレスは `bot/state.json` に保存されます（アドレスのみで、秘密鍵は保存されません）。

プロンプトをスキップして自動実行する場合:

```bash
PRIVATE_KEY=0x... node start.ts --yes --deposit 100000     # deposit 100000 on each chain; --deposit all / 0; --token USDT
node start.ts --chains mainnet,arbitrum                    # only these chains
```

### ウォレットの指定方法

プロンプト表示時に以下のいずれかを貼り付けるか（入力は非表示で保存されません）、環境変数 `PRIVATE_KEY`、`MNEMONIC`、`KEY` に設定してください。
`KEY_ENV=<別の環境変数名>` や `KEY_FILE=<鍵を保存したファイルパス>` も使用できます。

| 入力形式 | 備考 |
|---|---|
| 秘密鍵 | `0x` の有無、大文字・小文字、引用符、改行があっても問題ありません |
| ニーモニック | 12–24 単語。改行、カンマ、番号（`1.` `2)` `3、`）、大文字・小文字は自由です。英語、簡体字・繁体字中国語、日本語、韓国語、スペイン語、フランス語、イタリア語、チェコ語、ポルトガル語の単語リストに対応（中国語はスペースなしでも可）。タイポがある場合は最も近い単語を提案し、チェックサムが不正な場合は拒否します |
| Keystore ファイルパス | MetaMask のエクスポート、geth、または `cast wallet import` で作成した JSON。続けてパスワードの入力を求められます |
| `foundry:<name>` | `~/.foundry/keystores/<name>` を読み込みます。`--account <name>` も同じ動作です |
| `op://vault/item/field` | 1Password CLI（`op read`）で読み込みます |

ニーモニックを入力すると、主要な派生アカウント（MetaMask #0–#4、Ledger Live #1–#2）について各チェーンの ETH・ステーブルコイン残高および既存コントラクトを一覧表示し、資金が入っている最初のアカウントを自動選択します。特定のアカウントを指定するには `MNEMONIC_INDEX=2` または `MNEMONIC_PATH="m/44'/60'/0'/0/7"` を設定してください。

Mac では初回入力後に、ウォレットを macOS キーチェーンに記憶させるか尋ねられます（デフォルトは No）。Yes を選ぶと、次回からは Enter を押すだけで起動できます。
キーチェーンにはニーモニック全体ではなく、選択されたアカウントの秘密鍵のみが保存されます。削除するには `node start.ts forget` を実行します。

### 全決済と出金 (exit)

```bash
node start.ts exit
```

各チェーンで借入債務がゼロになるまで WETH の買い戻しを続け、すべての担保をウォレットに出金し、コントラクトに残った端数（ダスト）も回収します。
- コントラクトはそのステーブルコインで支払える分だけ買い戻すため、USDC と USDT にまたがるポジションはステーブルコインを交互に使いながら複数ラウンドでクローズされます。ごく少量しか約定できないプールは後回しにされます。
- Aave の凍結中でも動作します。凍結は新規の預け入れと借入を止めるだけで、返済と出金は妨げられません。
- クローズできない場合は理由が表示されます。すべてのプールの価格がオラクルより `EXIT_MAX_PREMIUM_BPS`（デフォルト 3%）を超えて高い場合（時間をおいて再実行するか上限を引き上げてください）、または Aave のステーブルコイン流動性がすべて借り出されていて担保を引き出せない場合（**コントラクトアドレスに直接ステーブルコインを送金してください**。コントラクトは支払い時に手元の残高を優先して使用します）です。他のチェーンの処理はそのまま続行されます。

別のマシンからでも `exit` できます。`state.json` がない場合、ボットはこのウォレットが直近 300 トランザクションでデプロイしたコントラクトをスキャンして自動的に見つけ出します。
または、`ARB_ADDRESS_MAINNET=0x… node start.ts exit`（および `ARB_ADDRESS_ARBITRUM`、`ARB_ADDRESS_BASE`、`ARB_ADDRESS_OPTIMISM`）で直接アドレスを指定することもできます。

### その他のコマンド

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

（預言機 = オラクル、Aave 凍結中 = Aave 凍結中。）何も起きていないときは、各チェーン `LOG_MS`（30 秒）ごとに 1 行出力します。プレミアムがオープン閾値の半分を超えているとき、ポジションを保有しているとき、またはトランザクションがペンディング中のときは毎ブロック出力します。

### ボットの判定ロジック

各チェーンは毎ブロック独立して以下のリストを上から順に評価し、最初に合致したルールを実行します。すべてのトランザクションは事前にシミュレーション（eth_call）され、失敗する場合は送信されません。
各チェーンで同時にペンディングになるトランザクションは最大 1 つです。

1. 前回のトランザクションがまだマイニングされていない → 待機します。マイニングされるか、同じ nonce が消費されるか、Flashbots が FAILED / CANCELLED / UNKNOWN を返した時点で解除されます。
   フォールバックの上限はメインネットで 10 ブロック（L2 でも同程度の時間）です
2. 預け入れ待ちの元本があり、Aave が受け入れ可能な状態になった（凍結されておらず、Supply Cap に空きがある） → 預け入れ（deposit）を実行します
3. 借入があり、HF < `EMERGENCY_HF` → プレミアムの有無にかかわらず、すべてクローズするのではなく、**HF を `EMERGENCY_TARGET_HF`（+5% の余裕）に戻すのに必要な分だけ買い戻します**。
   その価格で買い戻すとさらに HF が下がってしまう場合にのみ、全ポジションをクローズします。どのプールでも約定できない場合は、コントラクトにステーブルコインを送るか `repayFromOwner` で WETH を直接返済するよう促します
4. 利用可能なプールのプレミアムが `OPEN_PREMIUM_BPS` 以上で、かつ `CONFIRM_SECONDS` 秒間持続している →
   **まずアグリゲーターに問い合わせます**: サイズはヘルスファクターが許容する上限（プレミアムの半分で試算）と下記の 1 トランザクションあたりの上限のうち小さい方です。クオートがオラクルの下限価格を下回る場合はサイズを最大 3 回まで半減させ、シミュレーションに通ったら `openVia` を送信します。アグリゲーターが応答しないか、すべてのクオートが基準に満たない場合にのみ、単一の Uniswap プールに対してプレミアムが高い順に `open` を試し、1 つ送信した時点で終了します。
   アグリゲーターが利用可能な間は、Aerodrome/Velodrome プールで検知されたプレミアムも対象になります。
   「利用可能」とは、Aave の WETH が凍結されておらず、対象のステーブルコインが預け入れ可能（非凍結、LTV > 0、Supply Cap に空きあり）で、プールに少なくとも `MIN_POOL_WETH` 以上の WETH がある（枯渇したプールは除外）状態を指します。
   1 回のトランザクションで売却する最大量は、`MAX_WETH_PER_TX`、Aave でまだ借入可能な WETH の 95%、そのステーブルコインでまだ預け入れ可能な枠の 95%（WETH 換算）のうち最小の値です。
   サイズはまずプレミアムの半分で見積もられ（初回トランザクションで最大限オープンするため）、ヘルスファクターが不足してコントラクトが revert した場合は最も保守的な見積もりにフォールバックします。
   利用可能なプールでプレミアムが続いている間はポジションを維持し、クローズしません。枯渇したプールや預け入れ不可能なプールでしかプレミアムが見られない場合はステップ 5 に進みます
5. 借入があり、いずれかのプールのプレミアムが `CLOSE_PREMIUM_BPS` 以下になった → WETH が最も安く、かつ対応するステーブルコイン担保をコントラクトが十分に保有しているプールから順に買い戻します。
   単一プールでクローズできない場合（すべてのプールが価格制限に達して `NoEdge` になるなど）は、アグリゲーターの `closeVia` に切り替えます。緊急デレバレッジや `exit` でも同様に、単一プールで失敗したらアグリゲーターを使用します

`CLOSE_ONLY=1` を設定すると、1、3、5 のみを実行します（新規預け入れも新規オープンも行わず、ポジションの解消のみを行います）。

### 実運用に入る前の注意点

- **ボットは常時稼働させておく必要があります。** 今回のイベントでは、トップトレーダーは発生から 24 分後に参入し、有効な時間枠は約 1 時間でした。ノート PC がスリープしていると機会を逃します。
  Mac では `caffeinate -i` を使うか、常時稼働の Linux マシンでスーパーバイザー配下で動かしてください（次のセクションを参照）。
- 現在（2026-10-30）Aave は凍結中です。今のうちに `node start.ts` を実行しておくことができます。コントラクトのデプロイと元本の approve を済ませて待機し、凍結解除後にボットが自動で預け入れます。
  元本が Aave に預け入れられると、供給金利（Supply Interest）も得られます。
- メインネットでは、トランザクションはデフォルトで Flashbots Protect（`SEND_RPC_URL_MAINNET`）を経由します。フロントランやサンドイッチ攻撃を防ぎ、失敗したトランザクションはブロックに取り込まれないためガス代もかかりませんが、取り込まれるまでに数ブロックかかるか、取り込まれない場合があります。L2 ではチェーンの RPC に直接送信されます。速度競争に勝つには `PRIORITY_FEE_GWEI` を設定してください。
- パブリック RPC はレート制限にかかることがあります。各チェーンにはデフォルトで 2 つのパブリック RPC が設定されており、1 つ目が失敗すると 2 つ目に切り替わります。独自の RPC（Alchemy、Infura など）がある場合は、`RPC_URLS_<CHAIN>` にカンマ区切りで設定してください（順番に試行されます）。
- 起動時に接続できなかったチェーンやセットアップが未完了のチェーンは、無人モード（`--yes`）では毎分リトライされ、復旧し次第自動的に監視・取引対象に加わります。1 つのチェーンの障害が他のチェーンに影響することはありません。

## 常時稼働デプロイ (Linux)

取引を行うマシン上で以下を実行します。

```bash
git clone https://gitlab.com/aa22396584/aave-oracle-lag-arb.git && cd aave-oracle-lag-arb
bash deploy/install.sh            # --with-op adds the 1Password CLI
~/.local/share/aave-oracle-lag-arb/set-wallet.sh
~/.local/share/aave-oracle-lag-arb/trader.sh start
```

手元のノート PC からリモートサーバーをセットアップする場合（`host` を置き換えてください。`-t` を付けることで `set-wallet.sh` の非表示プロンプトが表示されます）:

```bash
ssh -t host 'git clone https://gitlab.com/aa22396584/aave-oracle-lag-arb.git && cd aave-oracle-lag-arb && bash deploy/install.sh && ~/.local/share/aave-oracle-lag-arb/set-wallet.sh'
ssh host ~/.local/share/aave-oracle-lag-arb/trader.sh start     # keeps running after ssh disconnects
```

### install.sh の処理内容

- `PATH` にある Node 20+ を使用します。存在しないかバージョンが古い場合は、固定バージョンの Node 22 ビルド（Linux x64/arm64 のみ）をダウンロードして sha256, バイナリを検証した上で `node` バイナリのみを `APP_DIR` にコピーします。
- `npm ci` を実行した後、esbuild で `bot/` を単一ファイル `bot/dist/aave-oracle-lag-arb.mjs` にバンドルします（実行時に `node_modules` は不要です）。実行前に `bot/node_modules` が存在しなかった場合は、バンドル後に削除します（小規模環境での inode 枯渇を防ぐため）。
- バンドルファイル、`bot/OracleLagArb.json`、`trader.sh`、`set-wallet.sh`、`set-alerts.sh` を `APP_DIR` にコピーします。
- `--with-op` を指定すると、1Password CLI も `APP_DIR` にインストールします（Linux x64/arm64 のみ。解凍に `python3` が必要です）。
- `--bundle-node` を指定すると、固定バージョンの Node を常に `APP_DIR` に置きます。再起動でシステムの Node が消えるマシン（Grok Bot のコンピュータなど）向けです。
- ボットが稼働中であれば再起動し、そうでなければ次の手順を表示します。

実行には `bash`、`git`、`curl` が必要です。Node を自動ダウンロードする場合は `sha256sum` と `.tar.xz` を展開できる `tar` も必要になります。

| | デフォルト | 格納される内容 |
|---|---|---|
| `APP_DIR` | `~/.local/share/aave-oracle-lag-arb` | バンドル済みボット、`trader.sh` などのスクリプト、ダウンロードされた `node` / `op`、ログ `trader.log`、`state.json`（コントラクトアドレス）、ハートビート、チェック状態 |
| `ARB_CONFIG_DIR` | `~/.config/aave-oracle-lag-arb` | `env`（ウォレットや各種設定）および `alerts.env`（Webhook）。パーミッションはファイルが mode 600, ディレクトリが 700 |

`APP_DIR` はインストール時のみ参照されます（`APP_DIR=/opt/arb bash deploy/install.sh`。アップデート時も同じ値を指定してください）。インストール後のスクリプトは自身のディレクトリを認識します。
`ARB_CONFIG_DIR` を変更する場合は、スケジューラからの呼び出しも含め、`set-wallet.sh`、`set-alerts.sh`、`trader.sh` のすべての呼び出しで同じ値を設定してください。

### ウォレットの設定 (set-wallet.sh)

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

| モード | env ファイルに保存される内容 |
|---|---|
| プロンプト、`--from-env` | `KEY=<値>`（秘密鍵またはニーモニックそのもの） |
| `--env-name` | `KEY_ENV=<変数名>`（変数名のみ）。再起動後にスケジューラの環境変数にその変数が存在しない場合、`ensure` は「この環境には変数がありません」と出力して起動を見送ります |
| `--op`、またはプロンプトで `op://` を入力 | `OP_SERVICE_ACCOUNT_TOKEN` と `KEY=op://…`。この鍵だけを入れた専用 Vault を用意し、トークンにはその Vault の読み取り権限のみを付与してください |
| `--index`、`--path` | `MNEMONIC_INDEX` / `MNEMONIC_PATH`。単独で実行すると鍵はそのままにアカウントだけを変更します。上記の各モードと組み合わせることも可能です |

- 鍵が画面に表示されたり、コマンドライン引数として渡されたりすることは一切ありません。env ファイル内の他の行（チューニング用変数や RPC 設定など）は維持され、ウォレット関連の行だけが書き換えられます。
- 最後に `trader.sh whoami`（トランザクション送信なし）を実行し、ウォレットアドレスと各チェーンの残高を表示して終了します。
- ニーモニックでアカウントが指定されていない場合、`whoami` は失敗してアカウント一覧を表示します。案内された通りに `--index` または `--path` でアカウントを指定してください。無人モードではアカウントの推測を絶対に行いません（誤って別のウォレットの資金を預け入れたり、再起動時にアドレスが変わったりするのを防ぐためです）。
- Keystore ファイルは起動のたびにパスワード入力が必要になるため、バックグラウンドで動くスーパーバイザーでは使用できません。常時稼働には秘密鍵、ニーモニック、または 1Password を使用してください。
- env ファイルを使わずに、`trader.sh` の実行環境から `KEY`、`PRIVATE_KEY`、`MNEMONIC`、`KEY_ENV`、`KEY_FILE=<鍵ファイルのパス>` を直接読み込ませることも可能です。

### 操作コマンド (trader.sh)

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

| コマンド | 動作内容 |
|---|---|
| `start` | バックグラウンドで実行し、ターミナルや SSH セッションを閉じても稼働し続けます。ボットが終了した場合は自動で再起動します |
| `ensure` | `start` と同じですが、ウォレットが未設定の場合や `stop` で明示的に停止されている場合は何もせず終了します。前回のモードを維持します |
| `close-only` | クローズ専用モードで再起動します |
| `stop` | 停止します（ポジションは維持されます）。`ensure` では再開されず、`start` を実行したときのみ再開します |
| `status` | 稼働状態、モード、前回終了時の時刻と終了コード、ログの末尾 8 行を表示します |
| `logs` | ログをリアルタイム表示（follow）します |
| `whoami` | ウォレットアドレスと全チェーンの残高を表示します（鍵が読み取れるかどうかの確認） |
| `check` | 単発のヘルスチェックを実行し、JSON で出力します。終了コード 0 = 前回から変化なし、1 = 変化あり、その他 = エラー。秘密鍵は不要です（[アラート](#アラート)を参照） |
| `exit` | ボットを停止した上で全ポジションをクローズし、ウォレットへ出金します。完了できなかった場合はクローズ専用モードで再起動します |

### スーパーバイザーの動作仕様

- ボットを `start --yes --deposit all` で起動します。Aave が受け入れ可能なすべてのチェーンで**ウォレット内の全 USDC/USDT が元本として預け入れられ**、ETH はガス代としてウォレットに残ります。クローズ専用モードでは `--deposit 0` を使用します。
- ボットが終了すると自動で再起動します。5 分以上稼働した後の終了であれば 10 秒後に再起動します。起動から 5 分以内の終了は失敗とみなされ、n 回連続で失敗すると n × 30 秒（最大 5 分）待機してから再起動し、諦めずに試行を続けます。
  3 回連続で失敗し、かつ最新の失敗が 15 分以内である場合、`check` は `trader_crashloop` を報告します。
- `stop` で停止させると、`ensure` を実行しても停止状態が保たれます。マシンが再起動した場合は、スケジューラが `ensure` を実行するまでボットは起動しません（[AI エージェントでの運用](#ai-エージェントでの運用)を参照）。
- `exit` が完了できなかった場合（価格が高すぎる、ステーブルコインが引き出せないなど）は、クローズ専用モードで再起動してポジションの監視・管理を続けます。後ほど再度 `exit` を実行してください。
  `ensure` はマシンの再起動後も含め、クローズ専用モードを維持します。
- ログは `APP_DIR/trader.log` に出力されます。サイズが 20 MB を超えると `trader.log.1` にコピーされて切り詰められます（起動前および 5 分ごとにチェック）。ディスク容量不足などでハートビートファイルが書き込めない場合でも、取引自体は継続されます。
- コントラクトアドレスは `APP_DIR/state.json` に保存されます。このディレクトリが失われた場合は `install.sh` を再実行してください。ウォレットのトランザクション履歴からコントラクトアドレスが再検出され、状態ファイルが再構築されます。

### アップデート方法

```bash
cd aave-oracle-lag-arb && git pull && bash deploy/install.sh     # restarts the bot if it is running
```

インストーラは `ARB_CONFIG_DIR` に一切触れないため、ウォレットや Webhook の設定はそのまま引き継がれます。

### 秘密鍵の安全管理

- **複数のボットやエージェントで共有されているマシン（エージェントプラットフォーム上のコンピュータを含む）では、ボットが稼働すると他のボットやエージェントからも秘密鍵を読み取れる状態になります。**
  どの方法でウォレットを渡しても、最終的に秘密鍵はそのマシン上のボットプロセス内に展開されます。必ずこの戦略の資金だけを入れた専用ウォレットを使用してください。
- env ファイルのパーミッションは 600、ディレクトリは 700 に設定されます。3 つのスクリプトはいずれも鍵を画面に出力したりコマンドライン引数に渡したりしません。

### macOS での実行

スーパーバイザーは Linux 専用です（`setsid` と `/proc` を使用するため）。Mac ではターミナルからソースコードを直接実行してください。

```bash
cd bot && npm install && caffeinate -i node start.ts
```

### 検証済みの項目

2026-10-30 にクラウド上の Linux x64 VM と空のテスト用ウォレットで以下を検証済みです。
- システムの Node 20, および固定バージョンの Node 22 自動ダウンロードを用いた `install.sh`
- 環境変数からの `set-wallet.sh`: ニーモニック → アカウント一覧 → `--index`、秘密鍵、`--env-name`（変数が設定されている場合とされていない場合）
- `set-alerts.sh` のテスト POST: HTTP 200 で成功、404 で失敗すること
- `trader.sh` の `start`、`status`、`stop`、`ensure`

未検証の項目: 実際のトークンを用いた 1Password 経路、Grok Bot および Hermes Agent のエンドツーエンドのフロー。

## AI エージェントでの運用

ボットは特定のエージェントに依存していません。すべての操作は `deploy/` 内のスクリプト経由で行われるため、シェルを実行できるエージェントであればどれでも運用できます。

| ファイル | 用途 |
|---|---|
| `skills/aave-oracle-lag-arb/SKILL.md` | スキル定義（[agentskills.io](https://agentskills.io) 形式）: インストール、ウォレット設定、起動、定期チェック、検出結果の読み取り、全決済（exit） |
| `.claude/skills/` | 上記スキルへのリンク。リポジトリを開くと Claude Code が自動で認識します |
| `.agents/skills/` | Codex 用のスキルリンク |
| `AGENTS.md` | リポジトリのコードを変更するコーディングエージェント向けガイド（Codex、Cursor 用。Claude Code は CLAUDE.md 経由で読み込みます） |

スキル定義では、秘密鍵を決して通常のチャット欄には入力させず、プラットフォームのマスクされたシークレット入力機能から環境変数として受け取って `set-wallet.sh --from-env` を実行すること、起動前にアドレスと残高を表示して一度確認を取ること、そしてユーザーの指示があった場合にのみ `stop`、`close-only`、`exit` を実行することが指示されています。

### Claude Code, Codex, Cursor

取引を行うマシンでリポジトリを開き、「このマシンに oracle-lag ボットをセットアップして」と伝えてください。

任意のディレクトリからスキルを使えるようにするには、スキルをコピーします。

```bash
cp -r skills/aave-oracle-lag-arb ~/.claude/skills/    # Claude Code
cp -r skills/aave-oracle-lag-arb ~/.agents/skills/    # Codex
```

### Hermes Agent

```bash
cp -r skills/aave-oracle-lag-arb ~/.hermes/skills/
hermes skills list | grep aave-oracle-lag-arb   # picked up? in an open session, /reload-skills refreshes slash commands
```

Hermes では `hermes skills install <owner>/<repo>/<path>` で GitHub パスからスキルをインストールすることも可能です。ミラーリポジトリは `akari-sora/aave-oracle-lag-arb`、スキルパスは `skills/aave-oracle-lag-arb` です（未テスト）。
その後、Hermes にボットのインストールと、6 時間ごとに `trader.sh ensure` に続けて `trader.sh check` を実行するスケジュール設定を依頼してください。

### Grok Bot

最速の方法: テンプレート [https://x.ai/bot/4OryWRBkWbghpXyZytSSm](https://x.ai/bot/4OryWRBkWbghpXyZytSSm) を開き、**Add to Grok Bot** を選択します。自分専用のボットのコピーが作成されるため、ウォレットのシークレット、ルーチン、コンピュータはすべて自分専用になります。
その後、「セットアップして」「ウォレットを設定して」と伝えます。詳細や手動で作成する場合のペルソナ設定は [integrations/grok-bot.md](integrations/grok-bot.md) に記載されています。
Grok Bot のコンピュータ上にトレーダーをインストールし、マスクされたシークレットカード経由で鍵を受け取り、6 時間ごとに `ensure` と `check` を実行するルーチンを設定します。`set-alerts.sh` で Webhook トリガーのルーチンを接続すれば、即時アラートを受け取ることも可能です。

1 つの Grok アカウント内のすべてのボットは同じコンピュータを共有します（[xAI docs](https://docs.x.ai/grok-bot/security-faq): "Treat a login or file on the computer as available to every Bot that user runs"）。

### その他のエージェント、または通常の cron

スケジューラは以下の 2 つのコマンドを順番に実行するだけで十分です。ボット自体は毎ブロック反応するため、スケジュール実行は 6 時間ごとで問題ありません。

```bash
APP=~/.local/share/aave-oracle-lag-arb
$APP/trader.sh ensure     # start it if it isn't running; skips if no wallet is set or it was stopped on purpose
$APP/trader.sh check      # prints one JSON object
```

`ensure` が `started` と出力した場合は、ボットが異常終了していたかマシンが再起動したことを意味するため、通知を送る価値があります。

| `check` の終了コード | 意味 | 対応 |
|---|---|---|
| 0 | 前回のチェックから変化なし | 通知しない |
| 1 | 新しい事象が発生したか、既存の事象が解消された | `new` と `resolved` の内容を 1〜2 文で要約して通知する |
| その他 | エラー | エラーの先頭数行を毎回ではなく一度だけ報告する |

```json
{"changed": true, "findings": [{"level": "warning", "code": "premium_open:base", "kind": "condition", "message": "…"}], "new": ["premium_open:base"], "resolved": []}
```

初回実行時は、warning または critical の検出項目（finding）がある場合にのみ「変化あり（changed）」とみなされます。前回実行時のコード一覧は `APP_DIR/check-state.json` に保存されます。各コードの意味は[アラート](#アラート)で説明しています。
即時通知が必要な場合は、`set-alerts.sh` で Webhook を設定してください（ペイロードの形式も[アラート](#アラート)を参照）。

通常の cron を使う場合:

```
@reboot      $HOME/.local/share/aave-oracle-lag-arb/trader.sh ensure
0 */6 * * *  $HOME/.local/share/aave-oracle-lag-arb/trader.sh ensure
```

cron 自体はメッセージを送信しないため、Webhook と併用するか、終了コード 1 のときに通知を送る独自スクリプトで `trader.sh check` をラップしてください。
cron は最小限の `PATH` で起動するため、`node` が `/usr/bin` にない場合（nvm でインストールした場合など）は crontab の先頭で `PATH=` を設定してください。

## アラート

`check` と Webhook は同じ検出項目（findings）のリストを共有します。各コードの末尾には `:<chain>`（例: `premium_open:arbitrum`）が付くため、同じ問題でもチェーンが異なれば別の項目として扱われます。

| code | level | 発生条件 |
|---|---|---|
| `premium_open:<chain>` | warning | 最も高いプールのプレミアムが `OPEN_PREMIUM_BPS` 以上になった（Aave が凍結中の場合は借入不可である旨がメッセージに含まれます）。プレミアムが「閾値 − 1%」（閾値が 2% 未満の場合は閾値の半分）を下回るまで継続します |
| `hf_low:<chain>` | critical | 借入があり、かつ HF < `EMERGENCY_HF` |
| `bot_not_running:<chain>` | warning | 取引機会またはポジションがあるにもかかわらず、このマシン上の当該チェーンのボットが直近 1 分間にハートビート（ボットと同じ場所にある `heartbeat-<chain>.json`。ソース実行時は `bot/`、スーパーバイザー配下では `APP_DIR`）を書き込んでいない |
| `action_failing:<chain>` | warning | `ACTION_FAIL_ALERT`（5）回連続でアクションが失敗した（シミュレーション失敗、トランザクション失敗、またはブロックに取り込まれなかった）。「価格制限に達したため待機中」はカウントされません |
| `gas_low:<chain>` | warning | ポジション保有中にウォレットの残高がメインネットで 0.02 ETH 未満 / L2 で 0.002 ETH 未満になった（緊急デレバレッジを送信できなくなる恐れがあります） |
| `trader_crashloop` | critical | `trader.sh` 配下のボットが起動後 5 分以内に終了する事象が 3 回連続で発生し、最新の終了が 15 分以内である（例: 1Password から鍵を読み取れないなど） |
| `rpc_error:<chain>` | warning | このチェーンの状態を読み取れなかった（`check` 実行時のみ） |
| `position_open:<chain>` | info | ポジションを保有中 |
| `aave_frozen:<chain>` | info | このチェーンでは借入できない：Aave V3 の WETH が凍結中、または担保にできるステーブルコインがない（凍結または LTV 0） |

### 定期チェック (Scheduled check)

`node start.ts check --json` は検出結果のリストを出力し、warning または critical が 1 つでもあれば終了コード 1 で終了します。メッセージは繁体字中国語です:

```json
[{"level": "warning", "code": "premium_open:mainnet", "kind": "condition", "message": "Ethereum Uniswap USDC 0.05% 的 ETH 比 Aave 預言機貴 +9.73%"}]
```

**変化があったときのみ通知**: `node start.ts check --json --state <file>` は前回実行時のコードを記憶し、新しい項目が現れたか消えたときのみ終了コード 1 で終了し、`{"changed", "findings", "new", "resolved"}` を出力します。初回実行時は warning または critical がある場合にのみ変化ありとみなされます。スケジュール実行にはこれを使用してください（変化がなければ通知なし）。
`trader.sh check` は状態ファイルを `APP_DIR/check-state.json` に指定してこれと同じ処理を実行します。

### Webhook

`watch` またはボットの実行中に `ALERT_WEBHOOK_URL`（および `Authorization: Bearer …` などの `ALERT_WEBHOOK_HEADER`）が設定されていると、いずれかのチェーンの検出リストに変化があるたびに 1 回 POST を送信します（初回は warning または critical がある場合のみ）:

```json
{"source": "aave-u-eth", "host": "…", "chain": "base", "time": "…", "block": "53272934", "findings": [...], "new": ["premium_open:base"], "resolved": []}
```

`host` はマシンのホスト名です。`resolved` に `aave_frozen:<chain>` が現れた場合は、そのチェーンで再び借入できるようになった（WETH の凍結解除、かつ LTV が 0 より大きいステーブルコインがある）ことを意味します。ボットは Webhook のレスポンスを待たないため（タイムアウト 10 秒）、取引判定の速度が低下することはありません。

### Webhook の設定 (set-alerts.sh)

スーパーバイザー配下では、URL とヘッダーは `ARB_CONFIG_DIR/alerts.env`（パーミッション 600）に保存されます。インストーラを再実行しても上書きされません。

```bash
$APP/set-alerts.sh https://example.com/hook                              # hidden prompt for the auth header or a bare token
$APP/set-alerts.sh https://example.com/hook --header-from-env ALERT_KEY  # take it from a variable (e.g. a secret an agent platform injected)
$APP/set-alerts.sh https://example.com/hook --no-auth                    # the URL itself carries the secret
$APP/set-alerts.sh --off                                                 # remove the webhook
```

- トークン文字列のみを入力すると `Authorization: Bearer <token>` に変換され、コロン（`:`）を含む文字列はヘッダー行全体としてそのまま使用されます。
- 保存後、ボットと同じ形式で検出項目が空のテスト POST `{"source":"aave-u-eth","test":true,"findings":[],"new":[],"resolved":[]}` を送信します。HTTP ステータスを表示し、2xx 以外の場合は終了コード 1 で終了します（設定自体は保存されるため、修正して再実行するか `--off` で解除してください）。
- ヘッダーはコマンドライン引数ではなくファイルディスクリプタ経由で curl に渡されます。
- ボットが稼働中の場合は、新しい設定を反映するために再起動されます。

## 設定 (Configuration)

すべての設定にはデフォルト値があります。ソースコードから実行する場合は、`bot/.env.example` を `bot/.env` にコピーしてください。起動時に読み込まれます（すでに環境変数として設定されている値が優先されます）。
スーパーバイザー配下では、`ARB_CONFIG_DIR/env` に変数を追記し（`set-wallet.sh` は他の変数を変更しません）、`trader.sh stop && trader.sh start` を実行してください。

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `CHAINS` | `mainnet,arbitrum,base,optimism` | 実行対象のチェーン |
| `RPC_URLS_<CHAIN>` | チェーンごとに 2 つのパブリック RPC（`bot/core.ts` 参照） | 読み取りおよびガス見積もり用。カンマ区切りで指定し、順番に試行されます。`<CHAIN>` は `MAINNET` / `ARBITRUM` / `BASE` / `OPTIMISM`。1 つだけ指定する場合は `RPC_URL_<CHAIN>` も使用可能 |
| `SEND_RPC_URL_<CHAIN>` | Mainnet は `https://rpc.flashbots.net/fast`、L2 は `RPC_URL_<CHAIN>` と同じ | トランザクション送信用の RPC |
| `PRIORITY_FEE_GWEI` | 自動見積もり | ブロックビルダーへの優先手数料（Tip） |
| `GAS_LIMIT_MULT` | 1.25 | ガスリミット = 見積もり値 × この倍率（見積もりからブロック取り込みまでの間にフラッシュスワップが追加の tick を跨ぐ場合に備えるため） |
| `MAX_FEE_BASE_MULT` | 2 | maxFeePerGas = base fee × この倍率 + tip |
| `OPEN_PREMIUM_BPS` | 300 | プレミアムが 3% 以上のときのみオープンする |
| `CONFIRM_SECONDS` | 15 | オープン前にプレミアムが閾値以上を維持しなければならない秒数。単発の大口取引による一時的な価格跳ね上がり（次ブロックで裁定されて消えるもの）を除外します（待機メッセージは `LOG_MS` ごとに出力） |
| `MIN_EDGE_BPS` | 50 | プレミアムが 0.5% まで下がったら売却を止める |
| `TARGET_HF` | 1.3 | オープン後の最低ヘルスファクター。1.05 以上である必要があります（「清算閾値 ÷ LTV」を下回ると Aave が借入を拒否するため）。起動時に検証されます |
| `MAX_WETH_PER_TX` | 0 | 1 トランザクションあたりの最大 WETH 売却量。0 = Aave の借入可能上限のみに制限される |
| `MIN_WETH_PER_TX` | 0.5 | この数量未満ではオープンしない |
| `CLOSE_PREMIUM_BPS` | 30 | プレミアムが 0.3% 以下になったら買い戻す |
| `EMERGENCY_HF` | 1.1 | HF がこれを下回ったら価格にかかわらずデレバレッジする |
| `EMERGENCY_TARGET_HF` | `TARGET_HF` と同じ | デレバレッジ時、HF がこの値まで回復したら買い戻しを止める |
| `MIN_POOL_WETH` | 5 | 保有 WETH がこれ未満のプールは枯渇（dead）とみなす |
| `CLOSE_ONLY` | — | `1` = ポジション解消のみ（新規オープンなし、新規預け入れなし） |
| `ACTION_FAIL_ALERT` | 5 | `action_failing` アラートを出すまでの連続失敗回数 |
| `EMERGENCY_MAX_PREMIUM_BPS` | 1000 | 緊急デレバレッジ時、オラクルより最大 10% 高くても買い戻す |
| `EXIT_MAX_PREMIUM_BPS` | 300 | `exit` 実行時、オラクルより最大 3% 高くても買い戻す |
| `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_HEADER` | — | アラート通知用 Webhook（[アラート](#アラート)を参照） |
| `AGGREGATOR` | `kyber` | `off` にするとアグリゲーター経路を無効化し、単一の Uniswap プールのみを使用する |
| `AGG_SLIPPAGE_BPS` | 100 | アグリゲーターに渡すスリッページ許容値。実際の価格保護はコントラクト内のオラクル下限価格で行われます |
| `WS_URL_<CHAIN>` | publicnode の `wss://` | 新規ブロックを購読し、到着し次第すぐに判定を行います（ポーリングより高速）。`off` で無効化。この変数を設定せずに `RPC_URL(S)_<CHAIN>` を変更した場合は購読されません |
| `POLL_MS` | 3000 | ポーリング間隔（WebSocket 切断時のフォールバック） |
| `MIN_TICK_MS` | 500 | 2 回の判定間の最小間隔（Arbitrum は秒間 4 ブロック生成されるため） |
| `LOG_MS` | 30000 | 何も起きていないときにログを 1 行出力する間隔 |
| `MNEMONIC_INDEX` / `MNEMONIC_PATH` | — | スキャンせずにニーモニックの派生アカウントを直接指定する |
| `ARB_ADDRESS_<CHAIN>` | `state.json` | 使用するコントラクトアドレス |
| `BOT_LANG` | — | `en` = メッセージを英語で表示。それ以外 = 繁体字中国語 |

## テスト

```bash
forge test -vv
```

- 各チェーンのテストは実際のチェーンをフォークし、ACL 権限を使ってガバナンスによる Aave の凍結解除をシミュレート（ステーブルコインの LTV が 0 の場合は 75% に戻す）した上で、実際の Uniswap プールを動かしてプレミアムを作り出します。
- RPC は `ETH_RPC_URL`、`ARB_RPC_URL`、`BASE_RPC_URL`、`OP_RPC_URL` から読み込まれます。ブロックを固定するには `FORK_BLOCK`、`ARB_FORK_BLOCK`、`BASE_FORK_BLOCK`、`OP_FORK_BLOCK` を設定し、未設定の場合は最新ブロックが使用されます。
- publicnode はメインネット、Arbitrum、Optimism について直近約 128 ブロック分の状態しか保持しないため（Arbitrum では約 30 秒分）、L2 のテストはデフォルトで公式 RPC を使用します。
  特定のブロックに固定して再実行する場合はアーカイブ RPC が必要です。
- 4 チェーンすべてのテストを実行すると約 2–3 分かかります（大部分は RPC からの状態取得の時間です）。

2026-10-30 時点の結果: 全 61 テストがパス（メインネット 19 個、各 L2 で 14 個ずつ）。損益の数値はフォークするブロックによって若干変動します。

| チェーン（プール） | 10% プレミアム時の利益（元本 100k USDC） |
|---|---|
| Mainnet (USDC 0.05%) | +13,974 USDC |
| Arbitrum (USDC 0.05%) | +14,721 USDC |
| Base (USDC 0.05%) | +13,681 USDC |
| Optimism (USDC 0.3%、流動性が浅めのプール) | +12,925 USDC |

ボット（TypeScript）の型チェックは `cd bot && npm run typecheck`（`tsc --strict`）で実行できます。

| テスト名 | 検証内容 |
|---|---|
| `test_profitWhenUniswapConvergesDown` | 全チェーンで、10% プレミアム → オープン → 1 日保有 → Uniswap 価格がオラクル価格に戻る → クローズを検証 |
| `test_open_revertsWithoutPremium` | プレミアムがない場合は `NoEdge` で revert すること |
| `test_open_sizingEdgeSellsMore` | 全チェーンで、プレミアムの半分でサイズを見積もることで初回トランザクションの売却量が増え（67.6 → 72.5 WETH）、かつ目標 HF を満たすこと |
| `test_close_usesIdleStableFirst` | 全チェーンで、クローズ時にコントラクト内の未使用ステーブルコインが優先して使われ、不足分のみ Aave から引き出されること |
| `test_flashCallbacks_rejectOutsiders` / `…rejectForeignFlashLoan` | 全チェーンで、アグリゲーター経路のフラッシュローンコールバックにおいて、Aave 以外からの呼び出し、コントラクト自身が開始していないもの、処理中でないものをすべて拒否し、第三者がこのコントラクトを受取人に指定したフラッシュローンも失敗すること |
| `test_openVia_guards` / `…revertsBelowEdge` / `…revertsWhenTooBig` | 全チェーンで、ルーターがホワイトリスト未登録、呼び出し元がオーナー以外、約定結果が「オラクル × 1.005」未満、または借入過多の場合にトランザクション全体が revert すること |
| `test_openVia_thenCloseVia` | 全チェーンで、ルーター（テストでは Uniswap SwapRouter02）経由で 20 WETH を売却してオープンし、買い戻してクローズした結果、債務がゼロ、approve がゼロになり利益が出ること。また上限設定が厳しすぎる場合に `closeVia` が過払いを拒否すること |
| `test_crossStable_closesInChunks` (mainnet) | ポジションの一部が USDC プール、大部分が USDT プールにある状態で、USDC だけでは全債務を返済できない場合に revert せず一部のみをクローズし、ステーブルコインを交互に使って債務ゼロまでクローズでき、最終資産が元本を上回ること |
| `test_oracleUpByHfMinusOne_liquidatable` | オラクル価格が (HF − 1) 上昇するとポジションが清算可能になること |
| `test_onlyOwner` / `test_callbackOnlyDuringOwnSwap` / `test_rejectsPoolNotFromFactory` | アクセス制御の検証 |
| `test_profitOnWethToken0Pool` (mainnet) | WETH/USDT 0.3% プール（WETH が token0）でも、5% プレミアムで正常にオープン・クローズでき、6,769 USDT の利益が出ること |
| `test_open_stopsAtPriceLimit` (mainnet) | 1% プレミアム・大口元本のケースで、プレミアムが（手数料控除後）0.5% まで下がった時点で売却が停止すること |
| `test_open_respectsMaxWethIn` (mainnet) | 1 トランザクションあたりの上限が機能すること |
| `test_oracleCatchesUp_noProfit` (mainnet) | オラクルが 10% 上昇して追いついた場合、クローズすると 166 USDC の損失になること |

### コントラクトを変更した後

`start.ts` は `src/` の sha256 ハッシュを記録した `bot/OracleLagArb.json` をデプロイします。ソースコードを変更した後にアーティファクトを再エクスポートしていない場合、デプロイは拒否されます。

```bash
forge build && node bot/export-artifact.ts
```

### 手動操作 (Foundry)

```bash
forge script script/Deploy.s.sol --rpc-url $ETH_RPC_URL --account <keystore name> --broadcast
cast send $ARB "open(address,uint256,uint256,uint256,uint256)" <pool> 50 50 1300000000000000000 0 --account <keystore>
cast send $ARB "close(address,uint256,uint256)" <pool> 30 0 --account <keystore>
cast send $ARB "withdraw(address,uint256,address)" $USDC $(cast max-uint) <your address> --account <keystore>
cast call $ARB "premiumBps(address)(int256)" <pool>
```

`Deploy.s.sol` はデフォルトでメインネットのアドレスを使用します。他のチェーンでは `AAVE_ADDRESSES_PROVIDER`、`WETH`、`UNI_V3_FACTORY` を上書きしてください（各チェーンのアドレスは `bot/core.ts` のチェーン設定にあります）。
WETH を保有している場合は、Uniswap を使わずに `repayFromOwner(amount)` で直接返済することもできます（事前にコントラクトへ WETH を approve してください）。
LTV が 0 の間に Aave に預け入れた資産は自動では担保として有効化されません。LTV が元に戻ったら `setCollateral(asset, true)` で担保設定を有効にしてください。

## 他のトレーダーの手法

2026-10-30 にまとめた記録です。時刻はすべて UTC です。「単一ソース（single source）」と記載された項目は情報源が 1 つのみで、それ以外は少なくとも 2 つの独立した情報源または一次データ（オンチェーン記録、Aave ガバナンス投稿）に基づいています。

**今回のイベント**

- 20:24 に Binance のホットウォレットから資金流出が始まり、20:34 に攻撃者が UniswapX 経由で 50M USDT を 20,940 ETH にスワップしたことでプレミアムが発生しました
  （[Decrypt](https://decrypt.co/382194/binance-hack-exit-ramps-defi-exchange-ethereum)）。
- プレミアムは Uniswap V3 の WETH/USDT 0.3% および ETH/USDC 0.05% プールで発生しました（単一ソース）。21:00 頃には Uniswap が約 2,700、Chainlink が約 2,250 でした
  （[The Defiant](https://thedefiant.io/news/markets/eth-trades-at-20-premium-on-uniswap-versus-binance)）。
- トップトレーダーはあらかじめ Aave メインネットに約 $37M の USDC を預け入れており、イベント開始から 24 分後に参入すると、DEX やアグリゲーターを通じて 1 回あたり 300–1,000 ETH、**計 18 回のトランザクションを手動で実行**し、2 時間以内に大部分をクローズしました。上位 10 アドレスの合計利益は 206 回の売却トランザクションで約 $6.36M、平均するとオラクルより約 10% 高い価格での売却でした。フラッシュローンやアトミックなトランザクションが使われたという報告は見当たりません
  （単一ソース: [0xNaiXi](https://x.com/0xNaiXi/status/2115967318274789609)）。
- 攻撃者自身も 20:57 から 21:01 の間に 60M USDT を預け入れ、Aave メインネットから 19,762 WETH を借入したため、アービトラージャーと同じ WETH プールを奪い合う形になりました
  （[TechFlow](https://www.techflowpost.com/en-US/article/34992)、[Cointelegraph](https://cointelegraph.com/news/binance-linked-wallet-faces-possible-exploit-blockchain-researcher-warns)）。
- 21:30 以降はプレミアムが 3–5% に縮小しました（単一ソース）。21:42 に Guardian が市場の凍結を開始しました（単一ソース）。**機会が終了したのは凍結のせいではなく、プレミアムが収束したためです。**
- Arbitrum、Base、OP でプレミアムが発生した形跡や、この取引に Spark、Morpho、Compound が使われた形跡は確認されませんでした。

**過去の類似イベント**

- LUNA（2022-05）: 市場価格が $0.01 まで暴落する中、Chainlink の minAnswer によってオラクル価格が $0.107 に張り付いたため、Venus や Blizz で LUNA を担保に他の資産が借り出されました
  （[rekt](https://rekt.news/venus-blizz-rekt)）。
- CRV（2022-11）: Mango Markets の攻撃者が Aave に USDC を預け入れ、CRV を借入してショート目的で市場に売り浴びせましたが、CRV がショートスクイーズを起こしてポジションは清算されました。トークンを借入して売却する行為はショートであり、そのトークンが騰貴すれば破綻します
  （[CoinDesk](https://coindesk.com/markets/2022/11/22/mango-exploiter-gets-liquidated-after-roiling-aave-using-20m-of-borrowed-curve-tokens)）。
- Kelp（2026-04）: 攻撃者が 46 分間で Aave から 82,650 WETH を借入し、利用可能な WETH 流動性が 1.4 時間で約 $689M から $1.5M まで激減しました
  （[Glassnode](https://research.glassnode.com/anatomy-of-a-liquidity-freeze/)）。1 トランザクションあたりの上限には利用可能な流動性を考慮する必要があります。
- CAPO（2026-03）: Aave の wstETH オラクルのパラメータ設定ミスにより約 2.85% 低く評価され、約 $27M が誤って清算されました
  （[The Block](https://www.theblock.co/post/393121)）。

**これらを踏まえた本プロジェクトの設計**: プレミアムが `CONFIRM_SECONDS` 秒間持続してからオープンする、Aave の借入可能流動性と Borrow Cap で各トランザクションに上限を設ける、毎ブロック再評価して段階的にポジションを積み増す、下限価格（Price Floor）で最悪約定価格を保証する、価格収束後に自動で買い戻す、凍結中はオープンせず凍結解除後に自動で元本を預け入れる。未実装の項目: 取引所でのヘッジ、逆方向の取引、他のレンディングプロトコルへの対応。

## リハーサル記録 (2026-10-30, anvil fork)

**デモ実行（メインネット、現在のコード、冒頭の GIF）**: Aave 凍結中 → ボットがデプロイして待機。凍結解除 → 100,000 USDC を自動預け入れ。
Uniswap USDC 0.05% を +10.09% に押し上げ → 15 s 後に 2 回に分けてオープン（73.02 + 5.63 WETH、ヘルスファクターは 1.337、次いで 1.303）。価格をオラクル水準に戻す →
2 つのプールでそれぞれ +0.3% の上限に達するまで買い戻し。`exit` で残りの 21.85 WETH を買い戻して全額出金: **100,000 → 116,484.18 USDC**。

**単一チェーン（メインネット）**: Aave の実際の凍結状態から開始し、`node start.ts --yes --deposit 100000` を実行:
デプロイ → 元本預け入れ待ち → 凍結解除をシミュレートし自動預け入れ → Uniswap を 10% 押し上げ、3 トランザクションでオープン → オラクル価格に戻った後クローズ: **100,000 → 115,979 USDC**。
再度オープンし、ボットを停止してから**ニーモニック**で `exit --yes` を実行: 1 ラウンドでクローズ・出金完了 → ウォレット残高 **134,537 USDC**。

**マルチチェーン（メインネット + Base の同時実行）**:

1. 各チェーンでコントラクトをデプロイして approve し、元本を預け入れ待ちとして記録
2. メインネットのみ凍結解除 → メインネットが自動で預け入れ。Base は 10% 押し上げられたが凍結中のため → アラート `premium_open:base`（借入不可である旨を記載）を出力し、ポジションは建てず
3. Base の凍結解除 → 自動で預け入れ → プレミアムはすでに `CONFIRM_SECONDS` 以上持続していたため、即座に 3 トランザクションでオープン
4. Base がオラクル価格に戻る → USDC 0.3% プールで 1 トランザクションでクローズ: **100,000 → 116,262 USDC**
5. 再度オープンした後、ニーモニックで `exit --yes` を実行: メインネットは 100,000.05 USDC を出金、Base は 1 ラウンドでクローズ・出金し **134,857 USDC**

**レビュー修正後の検証（Optimism、USDC + USDT の複数ステーブルコインまたぎ）**:

1. Aave 凍結中にボットを起動 → 凍結解除後に 100,000 USDC を自動で預け入れ
2. USDT プール（流動性が浅い）を 10% 押し上げ → 12.3 WETH 売却した時点で価格下限に達して停止。USDC プールを 10% 押し上げ → 1 トランザクション上限 25 WETH により 25 + 25 + 25 + 3 と売却し、HF 1.301 で停止
3. 価格が収束 → 買い戻しでプール価格が +0.3% の上限に達すると一旦待機し、価格が戻ってから再度買い戻す動作を繰り返し、複数ラウンドで債務ゼロまでクローズ: **100,000 → 116,198 (USDC + USDT)**
4. 再度オープンした後、Aave のオラクル価格を 25% 引き上げ（オラクルが追いつく状況をシミュレート） → HF が 1.04 に低下し `hf_low` アラート発生 → 55.6 WETH の買い戻し量を算出し、端数しか残っていない USDT プールをスキップして USDC プールで 30.6 WETH を買い戻し → **48 WETH のポジションを維持したまま HF を 1.326 へ回復**（全決済はしない）
5. `state.json` を削除し、アカウント未指定のニーモニックで起動 → 無人モードが起動を拒否。`MNEMONIC_INDEX=0` を指定すると、`exit` が**ウォレットのトランザクション履歴からコントラクトを再検出**し、クローズと出金を完了
6. 複数ステーブルコインにまたがる `exit`: USDT で 1 ラウンド、続いて USDC プールで残りの 85.7 WETH を 1 回で買い戻し、計 2 ラウンドで完了（修正前は同じケースで 13 ラウンドを要していた）

**アグリゲーター経路（Base、実際の KyberSwap ルート）**: フォーク環境で実際のオンチェーン状態から計算された KyberSwap ルートをそのまま実行できるよう、DEX 価格は動かさずに Aave のオラクルを 10% 引き下げ（DEX が 11% 割高に見える状態）て検証:

1. デプロイ、KyberSwap ルーターを自動でホワイトリスト登録、100,000 USDC を預け入れ
2. 最初の数回のアグリゲーターのオープンシミュレーションがタイムアウト（フォーク環境がルート上の各コントラクトをリモートから初めて取得するため）したため、ボットはまず Uniswap 単一プール経由で 81.08 WETH を売却。
   次のブロックからはアグリゲーターのシミュレーションが通り、**KyberSwap 経由で** 6.64 + 0.59 WETH をオープン（Aave 借入債務合計 88.31 WETH）、HF 1.300 で停止
3. オラクルを元の価格に戻し、KyberSwap のステーブルコイン → WETH ルートで **`closeVia`** を送信: 67,609 USDC で 30 WETH を買い戻し、債務は 88.31 → 58.25 に減少、ルーターへの approve はゼロにリセット
4. `exit` で残りを 1 ラウンドでクローズし全額出金: ウォレット残高 99,697 USDC。ここでの「プレミアム」はオラクルを引き下げて元に戻したもの（オラクルが追いついたケースと同じ）であるため利益は出ず手数料分のマイナスとなりましたが、アグリゲーターの動作メカニズムを検証できました。利益が出るシナリオについては上記の各セクションを参照してください

注記: アグリゲーター経由でのオープンは単一プールより多くのガスを消費します（今回のケースでは 3.1M 対 0.75M）。メインネットのガス代が高いときには重要になりますが、`MIN_WETH_PER_TX` はまだこれを考慮していません。
クローズ時は、`closeVia` に追加で 0.05% のフラッシュローン手数料がかかるため、まず単一プールを試みます。KyberSwap がレート制限（HTTP 429）を返した場合、そのチェーンは 30 秒間単一プールを使用します。

未リハーサルの項目: メインネットでの Flashbots Protect 経由の実ブロック取り込み（KyberSwap のルートが calldata 内に 10 分の deadline を含んでいることは 2026-10-30 に確認済み）、実際のイベント発生時における KyberSwap のクオートと約定、Aerodrome/Velodrome プールでの実際のプレミアム、Arbitrum 上でのボット稼働（コントラクトのフォークテストと読み取り専用の監視のみ確認済み）。

## ライセンス

AGPL-3.0-only です。[LICENSE](LICENSE) を参照してください。自由に使用・改変・共有できますが、改変版を配布する場合やネットワーク越しに他者へサービスとして提供する場合は、同じライセンスの下でソースコードを公開する必要があります。

金融アドバイスではありません。自己責任で使用してください。また、本ソフトウェアは未監査です。詳細は[免責事項](DISCLAIMER.ja.md)を参照してください。
