# API 使用方式（給庫開發者）

> 本文件為 **程式嵌入（API）層** 的使用說明，對象是想要把 DayBrain 模組
> 整合進自己程式的開發者。**一般使用者**請見 `README.md`（CLI 優先）。

所有模組以 TypeScript 撰寫，Node.js ≥ 20；可直接 `import` 原始 TS（`tsx`）
或編譯後之 `dist/`（`npm run build`）。

---

## MCP Client 連線層（`src/mcp/client.ts`）

```ts
import { McpClient } from './src/mcp/client.js';

const mcp = new McpClient({ serverBin: process.env.MCP_SERVER_BIN });
await mcp.connect();          // tools/list handshake
const env = await mcp.call('get_intraday_vwap', { symbol: '2308' });
// env = { data, _lineage, _chart_meta }（_lineage 供 Freshness Gate）
await mcp.close();            // 強制關閉 transport + 殺掉 child process
```

- `call` 回傳 Envelope（`{ data, _lineage, _chart_meta }`），`_lineage` 含資料新鮮度資訊。
- `close()` 已處理：3 秒超時 + child process 強殺 + stdio pipes 銷毀，避免子程序殘留。

---

## Freshness Gate 資料新鮮度守門（`src/gate/freshness_gate.ts`）

```ts
import { FreshnessGate } from './src/gate/freshness_gate.js';

const gate = new FreshnessGate({ stalenessMaxSec: Number(process.env.DATA_STALENESS_MAX_SEC) });
const env = await mcp.call('get_intraday_vwap', { symbol: '2308' });
const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
if (!r.passed) { /* 降級處理：STALE 停訊 / DEGRADED 停新訊 / LOCKOUT 全停 */ }
```

狀態機：`NORMAL → STALE → DEGRADED → LOCKOUT`（§3）。

---

## 事件日誌與回放（`src/logging/event_logger.ts`）

```ts
import { EventLogger } from './src/logging/event_logger.js';

const events = new EventLogger(process.env.LOG_DIR);
events.write('signal_issued', { signal_id: 'S1', symbol: '2308', score: 85 });

const day = events.loadDay('2026-08-10');     // 回放：依 ts 排序
const chain = events.loadChain('2026-08-10', { signal_id: 'S1' }); // 決策追溯
```

事件為 append-only JSON Lines（ts/type/version/seq + 自由欄位，zod 驗證），
是「決策可回放」的唯一資料來源，不得由 LLM 產生（§16）。

---

## 交易日曆與排程器（`src/scheduler/`）

```ts
import { TradingCalendar } from './src/scheduler/trading_calendar.js';
import { LifecycleScheduler, buildPhaseSchedules } from './src/scheduler/lifecycle_scheduler.js';
import { loadYamlFile } from './src/config/index.js';

// 1. 交易日判定（get_trading_calendar 快取於 LOG_DIR/calendar.json）
const cal = new TradingCalendar({ cacheDir: LOG_DIR });   // LOG_DIR 由 env 提供
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

`TradingCalendar.load()` 已處理「快取優先、失效刷新」；傳入的 `fetchFn`
回傳 `{ year, trading_days, holidays? }`。

---

## 盤前流程（`src/pre_market/`）

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

---

## 訊號評分引擎（`src/engine/scoring.ts`）

```ts
import { SignalScoringEngine, TickConfirmer, loadScoringConfigFromFile } from './src/engine/scoring.js';

const cfg = loadScoringConfigFromFile(process.cwd()); // config/scoring.yaml（scoring_version 寫入每筆評分）
const engine = new SignalScoringEngine(cfg, { neutralFlexible: bias === 'NEUTRAL_FLEXIBLE' });

const result = engine.score({
  direction: 'LONG', price, vwap, volumeSurgeRatio,
  dayHigh, dayLow15m, taifexTrend, distanceToLimitUpPct, dayGainPct, restriction,
});
// { total, breakdown: { level, volume, breakout, market, veto_penalty }, grade, veto_reasons, shouldEnter, scoring_version }

// 雙 tick 確認（§4 Phase 2）：兩次 tick 確認後才進入完整評分
const tick = new TickConfirmer(2);
if (tick.confirm(symbol)) { /* 進入完整評分 */ }
if (tick.isExpired(symbol, cfg.behavior.signal_expiry_min)) { /* 過期重評 */ }
```

---

## 回放工具（`src/tools/replay.ts`）

```ts
import { loadDayEvents, loadSignalChain } from './src/tools/replay.js';

const day = await loadDayEvents(LOG_DIR, '2026-08-10');   // 全日起因後果
const chain = await loadSignalChain(LOG_DIR, '2026-08-10', 'S1'); // 單一訊號決策鏈
```

用於決策追溯、滑價驗證（§12）。
