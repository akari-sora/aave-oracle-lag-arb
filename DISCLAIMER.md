# Disclaimer

[繁體中文](#免責聲明) · [简体中文](DISCLAIMER.zh-CN.md) · [日本語](DISCLAIMER.ja.md) · [한국어](DISCLAIMER.ko.md)

**This software is for education and research. It is not financial, investment, legal or tax advice, and nothing in this
repository is an offer or a recommendation to trade. Use it at your own risk, and only with money you can afford to lose
entirely.**

- **No warranty, no liability.** The software is provided "as is", without warranty of any kind. The authors and
  contributors are not liable for any loss, including lost funds, liquidations, failed or front-run transactions, or
  missed opportunities. See sections 15 and 16 of the [license](LICENSE).
- **Unaudited.** Neither the contract nor the bot has had a professional security audit. Bugs can lose funds. Read the
  code, run the fork tests and rehearse on a local fork before you put real money in.
- **It is a leveraged short-ETH position, not risk-free arbitrage.** If ETH rises far enough, the position is liquidated.
  If the oracle catches up instead of the DEX coming back down, the trade loses fees and gas.
- **Simulated results are not real results.** Every profit figure in this repository comes from fork tests or
  rehearsals where we created the price gap ourselves. They say nothing about what a real event would pay.
- **Third parties can change or fail.** The bot depends on Aave, Uniswap, Chainlink, KyberSwap, Aerodrome/Velodrome,
  Flashbots and public RPC providers. Markets can be frozen, parameters changed, liquidity drained, withdrawals stalled,
  and transactions delayed, dropped or front-run, at any time and without notice.
- **Your keys are your responsibility.** The bot needs a private key or mnemonic on the machine that runs it. Anyone or
  any program with access to that machine may be able to read it. Use a dedicated wallet holding only what you are
  willing to risk.
- **AI agents can make mistakes.** If you let an agent (Claude Code, Codex, Hermes Agent, Grok Bot or others) install
  or operate the bot, check what it does. The agent's provider is not responsible for this software, and neither is
  this project for the agent.
- **Follow the law where you are.** You are responsible for complying with the laws, regulations, sanctions and tax
  rules that apply to you. Market dislocations can involve funds from exploits or sanctioned parties; this software does
  not screen counterparties. Do not use it where it is prohibited.
- **No affiliation.** This project is not affiliated with, endorsed by or sponsored by Aave, Uniswap, Chainlink,
  KyberSwap, Aerodrome, Velodrome, Flashbots, Binance, xAI, Anthropic, OpenAI or Nous Research. Their names are used
  only to describe what the software interacts with.

By using this software you accept these terms.

---

# 免責聲明

[English](#disclaimer) · [简体中文](DISCLAIMER.zh-CN.md) · [日本語](DISCLAIMER.ja.md) · [한국어](DISCLAIMER.ko.md)

**這個軟體用於教育和研究，不構成任何金融、投資、法律或稅務建議，本 repo 的任何內容也都不是交易的邀約或推薦。
使用風險自負，只用你輸得起、全部賠光也能接受的錢。**

- **不提供保證，不負責損失。** 軟體依「現狀」提供，不附任何保證。作者和貢獻者對任何損失都不負責，包括資金損失、
  被清算、交易失敗或被搶先、錯過機會。見[授權條款](LICENSE)第 15、16 條。
- **沒有經過審計。** 合約和機器人都沒有做過專業的安全審計，程式錯誤可能讓你損失資金。放真的錢之前，
  請自己讀程式、跑 fork 測試，並在本機 fork 上演練。
- **這是加了槓桿的 ETH 空單，不是無風險套利。** ETH 漲太多會被清算；如果是預言機往上追、而不是 DEX 跌回來，
  這筆交易會賠掉手續費和 gas。
- **模擬結果不等於真實結果。** 本 repo 裡所有的獲利數字，都來自 fork 測試或我們自己製造價差的演練，
  不代表真實事件裡能賺多少。
- **第三方隨時可能改變或出問題。** 機器人依賴 Aave、Uniswap、Chainlink、KyberSwap、Aerodrome／Velodrome、
  Flashbots 和公開 RPC。市場可能被凍結、參數可能被改、流動性可能被抽乾、提款可能卡住，交易也可能延遲、
  沒上鏈或被搶先，都可能隨時發生、事先不通知。
- **私鑰由你自己負責。** 機器人要在執行它的電腦上放私鑰或助記詞，能存取那台電腦的人或程式都可能讀得到。
  請用專用錢包，只放你願意承擔風險的金額。
- **AI agent 會出錯。** 如果你讓 agent（Claude Code、Codex、Hermes Agent、Grok Bot 等）安裝或操作機器人，
  請自己確認它做了什麼。agent 的提供者不對本軟體負責，本專案也不對 agent 負責。
- **遵守你所在地的法律。** 你要自己負責遵守適用的法律、法規、制裁和稅務規定。市場異常時，交易對手可能包含
  被盜資金或受制裁的對象，本軟體不會篩選交易對手。在禁止使用的地方請勿使用。
- **沒有任何合作關係。** 本專案與 Aave、Uniswap、Chainlink、KyberSwap、Aerodrome、Velodrome、Flashbots、Binance、
  xAI、Anthropic、OpenAI、Nous Research 都沒有關係，也沒有獲得它們的背書或贊助。提到它們的名字，
  只是為了說明軟體會跟什麼互動。

使用本軟體，即表示你接受以上條款。
