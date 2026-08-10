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
  pre_market/   盤前流程（T006 ✅）：Phase 0 就緒檢查 + Phase 1 三路徑選股
  metrics/      績效指標（T010）
  llm/          LLM 檢討報告（T011）
  scheduler/    交易日曆與生命週期排程（T005 ✅）
  backtest/     回測與參數最佳化（T012/T022-T024）
  logging/      結構化 JSON 日誌（T001 ✅）+ 事件日誌與回放（T004 ✅）
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

## 事件日誌使用方式

```ts
import { EventLogger } from './src/logging/event_logger.js';
const events = new EventLogger(process.env.LOG_DIR);
events.write('signal_issued', { signal_id: 'S1', symbol: '2308', score: 85 });
const day = events.loadDay('2026-08-10');     // 回放：依 ts 排序
const chain = events.loadChain('2026-08-10', { signal_id: 'S1' }); // 決策追溯
```

## 排程器使用方式

```ts
import { TradingCalendar } from './src/scheduler/trading_calendar.js';
import { LifecycleScheduler, buildPhaseSchedules } from './src/scheduler/lifecycle_scheduler.js';
import { EventLogger } from './src/logging/event_logger.js';
import { loadYamlFile } from './src/config/index.js';

// 1. 交易日判定（get_trading_calendar 快取於 LOG_DIR/calendar.json）
const cal = new TradingCalendar({ cacheDir: env.LOG_DIR });
await cal.load(() => mcp.call('get_trading_calendar', {}).then((e) => e.data));
if (!cal.isTradingDay()) { /* 非交易日休眠：不排程任何 Phase */ }

// 2. 排程表（config/scheduler.yaml 為真值 + NO_ENTRY_AFTER/FORCE_CLOSE_AT 覆寫）
const raw = loadYamlFile(process.cwd(), 'scheduler.yaml');
const phases = buildPhaseSchedules(raw, { noEntryAfter: env.NO_ENTRY_AFTER, forceCloseAt: env.FORCE_CLOSE_AT });
const scheduler = new LifecycleScheduler(phases, {
  eventLogger: events,
  onTick: (phase, tick, now) => { /* Phase 2 每 10s：VWAP + 爆量偵測 */ },
  onPhase3Trigger: (phase, now) => { /* 11:30/12:30/13:00/13:10/13:15/13:20 時間規則 */ },
  onPhase: (phase, now) => { /* Phase 0/1/4 */ },
});

// 3. 主迴圈：每 10s 檢查一次
for (;;) { scheduler.checkAndFire(); await sleep(10_000); }
```

## 盤前流程使用方式

```ts
import { Phase0ReadyCheck } from './src/pre_market/phase0.js';
import { Phase1Selector } from './src/pre_market/phase1.js';

// Phase 0（08:15）：連線驗證 + 前一日盤後預熱
const p0 = new Phase0ReadyCheck({
  listTools: () => mcp.listTools(),
  mcpCall: (t, a) => mcp.call(t, a),
  gate: (env, scope, opt) => gate.check(env, scope, opt),
});
const ready = await p0.run(); // { connectionReady, dataGaps, warmup }

// Phase 1（08:30）：三路徑選股 → 過濾 → 候選清單 3–5 檔 → set_active_watchlist
const p1 = new Phase1Selector({
  mcpCall: (t, a) => mcp.call(t, a),
  gate: (env, scope, opt) => gate.check(env, scope, opt),
  today: todayInTaipei(),
  yesterday: previousTradingDay(),
});
const report = await p1.run(); // { candidates, watchlist, lowSignalDay, dataGaps }
```

## 任務狀態

- [x] T001 專案初始化與設定骨架
- [x] T002 MCP Client 連線層
- [x] T003 資料新鮮度守門
- [x] T004 事件日誌與回放
- [x] T005 交易日曆與生命週期排程器
- [x] T006 盤前流程（Phase 0 + Phase 1 選股）
- [ ] T007+ 依任務書依序實作

規格書：`~/tasks/tw-quant-daybrain/tw-quant-daybrain-v2_1.md`
