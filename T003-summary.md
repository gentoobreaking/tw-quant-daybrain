# T003 任務完成摘要

## 目標
實作 §3：以 `_lineage` 判定資料可用性之守門層，含降級狀態機（NORMAL / STALE / DEGRADED / LOCKOUT）與守門事件日誌。

## 完成內容
- **`src/gate/freshness_gate.ts`**：`FreshnessGate` class
  - §3.1 判定規則：盤中 `REALTIME_INTRADAY` + `fetched_at` 距今 ≤ `DATA_STALENESS_MAX_SEC`（預設 30s）；快取容許（`sampling_sec ≤ 10` 且 `cache_ttl ≤ 4`）；盤前 `POST_MARKET_TODAY`；歷史 `HISTORICAL` + `data_date` 覆蓋查詢範圍
  - 附錄 A：未知 `_lineage.source` 視同守門失敗（僅 TWSE/TPEx/MOPS/TAIFEX/MIS 通過）
  - §3.2 降級狀態機：STALE（單標的逾時 → 該標的停訊，`risk_status=STALE`）、DEGRADED（市場層資料逾時 → 停發新訊僅管持倉）、LOCKOUT（連續 3 次失敗或 MCP 連線中斷 → 全系統停訊）
  - 守門事件寫入：`freshness_gate_pass|fail`（含 cause、symbol、lagSec、state）
  - 狀態 API：`getState()` / `isSymbolStale()` / `getStaleSymbols()` / `recoverSymbol()` / `recoverFromLockout()` / `forceLockout()` — 供 T016 Bias 決策樹、T017/T018 策略引擎、T009 盤中循環、T008 Risk Manager 消費
  - `MARKET_LAYER_TOOLS`：台指期/PCR/漲跌家數 3 個市場層工具（§3.2）
- **`src/gate/freshness_gate.test.ts`**：25 個測試

## 驗收結果
| 驗收項目 | 結果 |
|---|---|
| §3.1 判定規則全數實作（時效/快取/盤前/歷史） | ✅ 含 29s/31s/30s 時間邊界 |
| §3.2 降級狀態機（STALE/DEGRADED/LOCKOUT） | ✅ 含轉移與恢復 |
| 未知 _lineage.source 視同守門失敗 | ✅ unknown_source |
| 守門事件日誌 freshness_gate_pass\|fail | ✅ 含 cause/symbol/lag_sec |
| 狀態 API 暴露消費端 | ✅ getState/isSymbolStale/... |
| 單元測試（狀態轉移、時間邊界、快取組合） | ✅ 55 tests pass（含 T001/T002） |

## 設計決策
- 守門狀態為「最嚴者優先」：任一標的 STALE 時全系統維持 STALE 等級；市場層失敗 → DEGRADED 優先於 STALE
- LOCKOUT 後即使資料新鮮也拒絕（`lockout_active`），須 `recoverFromLockout()`（MCP 重連成功）或 `forceLockout` 外部觸發
- STALE 標的以 `staleSymbols` Set 追蹤，恢復後自動移除
