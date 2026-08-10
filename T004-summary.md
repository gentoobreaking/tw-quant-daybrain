# T004 任務完成摘要

## 目標
實作結構化事件日誌系統（§1 原則 5「所有決策可回放」）：事件型別定義、寫入器（append-only）、回放（replay）讀取器。為 T010 績效統計與 T012 回放工具之唯一資料來源。

## 完成內容
- **`src/logging/event_types.ts`**：
  - `EVENT_TYPES` Enum：16 種事件（§14.4 全部 + v2.0 新增 bias_locked / briefing_generated / priority_ranked）
  - `EVENT_SCHEMAS` 註冊表：每種事件之必填欄位 + 型別檢查（zod 等效）
  - `validateEvent()`：寫入前驗證，失敗抛 `EventValidationError`（含欄位問題清單）
  - `DayBrainEvent`：ts / type / version / seq + 關聯欄位（signal_id / position_id / symbol）
- **`src/logging/event_logger.ts`**：
  - `EventLogger.write()`：append-only JSON Lines，每日一個檔案（`YYYY-MM-DD.events.jsonl`），seq 自動遞增
  - `loadDay(date) → Event[]`：依 ts 排序（同 ts 依 seq），損壞行跳過 + warning 回呼
  - `loadChain()`：依 signal_id / position_id 串接事件鏈（signal_issued → position_opened → position_closed）
- **`src/logging/event_logger.test.ts`**：13 個測試

## 驗收結果
| 驗收項目 | 結果 |
|---|---|
| 事件型別 Enum + Schema（§14.4 全部） | ✅ 16 種（含 v2.0 新增 3 種） |
| 事件 Schema 驗證（zod），失敗即抛錯 | ✅ EventValidationError + 不寫入 |
| append-only：JSON Lines + 每日一檔（YYYY-MM-DD.events.jsonl） | ✅ |
| 回放讀取器 loadDay(date) → Event[] 依 ts 排序 | ✅ 含同 ts seq 穩定排序 |
| 事件關聯 signal_id / position_id 串接 | ✅ loadChain 驗證 |
| 單元測試（序列化/跨日/損壞行跳過） | ✅ 68 tests pass（含 T001-T003） |

## 設計決策
- seq 以「掃描檔案最後有效行的 seq+1」計算，跨行程式實例續寫不重複
- 損壞行跳過（附 warning）而非中止回放，維持「回放不因單行損壞而失敗」
- 事件檔與 T001 JsonLogger 日誌檔分離（`.events.jsonl` vs `daybrain-*.jsonl`），事件為決策回放唯一來源
- 欄位新增靠 version 欄位向後相容
