# tw-quant-daybrain

台股當沖 DayBrain — 盤前/盤中/盤後自動化交易決策引擎（TypeScript）。

- **語言/執行期**：TypeScript，Node.js ≥ 20
- **MCP**：`@modelcontextprotocol/sdk`（stdio，已實作連線層）
- **設定**：`config/*.yaml` + 環境變數覆寫（§17.1 為唯一真值）
- **日誌**：結構化 JSON（事件型，含 ts/type），`LOG_DIR` 可設定
- **時區**：固定 `Asia/Taipei`，禁止本機時區隱式轉換

## 快速開始

```bash
npm install
npm run build      # tsc 編譯至 dist/
npm run test       # node:test 單元測試
npm run lint       # tsc --noEmit + eslint
npm run dev        # tsx 直接執行
node dist/index.js # 啟動最小進程
```

## 目錄結構

```
src/
  mcp/          MCP Client 連線層（T002 ✅）：Envelope 解析、重試、breaker
  gate/        資料新鮮度守門（T003 ✅）：降級狀態機 NORMAL/STALE/DEGRADED/LOCKOUT
  bias/         盤前多空傾向鎖定（T016）
  engine/       策略引擎（T017/T018）
  briefing/     Tactical Briefing 產生器（T019）
  execution/    下單執行與 Priority Ranking（T010/T020）
  risk/         風控系統（T008）
  metrics/      績效指標（T010）
  llm/          LLM 檢討報告（T011）
  scheduler/    交易日曆與生命週期排程（T005）
  backtest/     回測與參數最佳化（T012/T022-T024）
  logging/      結構化 JSON 日誌（T001）
  config/       設定載入（yaml + env 覆寫）
  utils/        時區等共用工具
test/
  mock_mcp_server.ts  mock MCP server（T002 整合測試）
config/
  scoring.yaml    訊號評分表（§8.2）
  scheduler.yaml  交易日排程（§18.2）
logs/             執行日誌（LOG_DIR）
data/historical_1m/ 回測歷史 1 分 K（DATA_DIR）
```

## MCP 使用方式

```ts
import { McpClient } from './src/mcp/client.js';
const mcp = new McpClient({ serverBin: process.env.MCP_SERVER_BIN });
await mcp.connect();          // tools/list handshake
const env = await mcp.call('get_intraday_vwap', { symbol: '2308' });
// env = { data, _lineage, _chart_meta }（_lineage 供 Freshness Gate）
```

## 環境變數

全部變數定義於 `src/config/env_defaults.ts`（§17.1 唯一真值），範例見 `.env.example`。
覆寫方式：`SCORE_THRESHOLD=90 node dist/index.js`。

## Freshness Gate 使用方式

```ts
import { FreshnessGate } from './src/gate/freshness_gate.js';
const gate = new FreshnessGate({ stalenessMaxSec: Number(process.env.DATA_STALENESS_MAX_SEC) });
const env = await mcp.call('get_intraday_vwap', { symbol: '2308' });
const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
if (!r.passed) { /* 降級處理：STALE 停訊 / DEGRADED 停新訊 / LOCKOUT 全停 */ }
```

## 任務狀態

- [x] T001 專案初始化與設定骨架
- [x] T002 MCP Client 連線層
- [x] T003 資料新鮮度守門
- [ ] T004+ 依任務書依序實作

規格書：`~/tasks/tw-quant-daybrain/tw-quant-daybrain-v2_1.md`
