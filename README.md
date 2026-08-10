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
npm run test       # node:test 單元測試（離線全綠）
npm run test:simulate   # 全盤模擬日（fixture 回放 Phase 0→4）
npm run test:simulate:unit # 模擬/故障注入單元測試
npm run start        # 單進程部署（交易日自動執行、非交易日休眠；MCP_SERVER_BIN 子程序）
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
  engine/       策略引擎（T017/T018）；訊號評分模型（T007 ✅）；盤中監控循環（T009 ✅）
  briefing/     Tactical Briefing 產生器（T019）
  execution/    下單執行與 Priority Ranking（T010/T020）
  risk/         風控系統（T008）
  pre_market/   盤前流程（T006 ✅）：Phase 0 就緒檢查 + Phase 1 三路徑選股
  metrics/      交易日誌與績效指標（T010 ✅）
  llm/          LLM 檢討報告（T011 ✅）：Schema 驗證、白名單、llm_offline
  scheduler/    交易日曆與生命週期排程（T005 ✅）
  backtest/     回測與參數最佳化（T022-T024）
  tools/        回放工具（T012 ✅）：決策追溯、滑價驗證、JSON/可讀輸出
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

## 訊號評分使用方式

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

## 任務狀態

- [x] T001 專案初始化與設定骨架
- [x] T002 MCP Client 連線層
- [x] T003 資料新鮮度守門
- [x] T004 事件日誌與回放
- [x] T005 交易日曆與生命週期排程器
- [x] T006 盤前流程（Phase 0 + Phase 1 選股）
- [x] T007 訊號評分模型（Config-Driven，§8）
- [x] T008 風控系統與持倉狀態機（§11）
- [x] T009 盤中監控循環（§4 Phase 2 + Phase 3）
- [x] T010 交易日誌與績效指標（§14.4/§15）
- [x] T011 LLM 檢討報告與防幻覺（§16）
- [x] T012 回放工具與滑價驗證（§1 原則 5）
- [x] T013 測試策略與模擬盤（Mock MCP Server + 模擬日 + 故障注入 + 回測 fixtures）
- [x] T014 部署與營運（單進程 + 子程序 MCP + 紙上交單 + headless + 優雅關閉）
- [x] T015 壓測與發布（全交易日壓測 + 參數實驗 + 附錄 A 對齊 + 契約相容 CI；v2.0 tag 待 T016–T024 完成）
- [x] T016 盤前多空傾向鎖定（Bias Decision Tree，§5；對齊 tw-quant-mcp v1.3 實際契約）
- [x] T017 做多策略引擎（VWAP_SURGE_LONG，§6）
- [x] T018 空方策略引擎（BULL_TRAP_VWAP_SHORT，§7）
- [x] T019 盤前戰術報告產生器（Tactical Briefing，§9）
- [x] T020 優先權排序引擎（Priority Ranking Engine，§10）
- [x] T021 回測資料載入器（CsvDataLoader，§12.3）
- [x] T022 事件驅動回測模擬器（§12）
- [x] T023 參數網格搜尋（§13.1）
- [x] T024 Walk-Forward Optimization（§13.3）

## 交易日排程（§18.2）

交易日自動執行以下時序（非交易日休眠；`config/scheduler.yaml` 為真值，
`NO_ENTRY_AFTER` / `FORCE_CLOSE_AT` 環境變數可覆寫）：

| 時間 | Phase | 動作 |
|------|-------|------|
| 08:15 | Phase 0 | 就緒檢查（交易日曆/行情源/權限） |
| 08:30 | Phase 1 | 盤前選股（三路徑合併、去重、watchlist ≤ 15 檔） |
| 08:55 | Briefing | 策略簡報鎖定（Bias 決策樹） |
| 09:00–12:30 | Phase 2 | 盤中監控（每 10s tick：VWAP + 爆量偵測 + 雙 tick 確認 + 評分） |
| 11:30 | Phase 3 | 停止新空單訊號 |
| 12:30 | Phase 3 | 警示不再開倉 |
| 13:00 | Phase 3 | 硬停多單新訊號 + 空單強制回補 |
| 13:10 | Phase 3 | 多方強平警告（FORCE_FLAT_ALL） |
| 13:15 | Phase 3 | 未平倉最高等級強平提醒 |
| 13:20 | Phase 3 | 強制全數平倉（FORCE_CLOSE_AT） |
| 14:30 | Phase 4 | 盤後統計 + 交易日誌 |

## 壓測與參數實驗（T015）

```bash
npm run stress   # 全交易日壓測：10s tick 連續 09:00–13:30（1621 ticks，驗證無遺漏/記憶體穩定）
npm run experiment -- --param volume_surge_threshold --values 3.0,2.5,3.5  # 參數對比
```

## 免責聲明

本專案為**研究/模擬用途**（paper trading），不構成任何投資建議。
所有訊號由規則引擎產生，經模擬盤（fixture 回放）驗證；實際交易前請自行評估風險。
自動化交易可能因資料延遲、系統故障或市場異常造成損失，使用者須自負全責。

---

規格書：`~/tasks/tw-quant-daybrain/tw-quant-daybrain-v2_1.md`
