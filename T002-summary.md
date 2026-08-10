# T002 任務完成摘要

## 目標
實作對 `tw-quant-mcp`（v1.3）之 MCP Client（§2.2 工具契約）：Stdio 連線、統一 Tool 呼叫封裝（Envelope 解析）、重試與斷線重連。

## 完成內容
- **`src/mcp/envelope.ts`**：Envelope 型別（data / _lineage / _chart_meta）+ `parseEnvelope()` 解析 + `McpEnvelopeError`（INVALID_ENVELOPE / MISSING_LINEAGE / MISSING_DATA）
- **`src/mcp/contracts.ts`**：§2.2 全部 18 工具之輸入/輸出型別 + `TOOL_CONTRACTS` 清單
- **`src/mcp/client.ts`**：`McpClient` — Stdio transport、tools/list handshake 驗證、`call(tool,args) → Envelope`、單一 Tool 失敗重試 2 次（指數退避 1s→2s）、斷線重連（指數退避 1s→30s）、circuit breaker（連續 5 次失敗 → 60s OPEN 並通知上層）、`McpCallError` 結構化錯誤
- **`test/mock_mcp_server.ts`**：以 SDK 實作之 mock MCP server（18 工具 + Envelope fixtures + 錯誤路徑控制）
- **`src/mcp/client.test.ts` + `envelope.test.ts`**：30 個測試（handshake、Envelope 解析、錯誤路徑、重試、breaker、_lineage 保留）

## 驗收結果
| 驗收項目 | 結果 |
|---|---|
| Stdio transport 連線 + tools/list handshake | ✅ mock server 整合測試通過（18 工具） |
| call(tool,args) → {data,_lineage,_chart_meta} + 結構化錯誤 | ✅ parseEnvelope + McpEnvelopeError/McpCallError |
| §2.2 18 工具型別定義 | ✅ contracts.ts + 測試比對清單 |
| 重試 2 次（1s→2s）+ 重連（1s→30s） | ✅ tool_retry 事件 + retried=2 驗證 |
| Circuit breaker 5 次→60s + 通知降級 | ✅ breaker_open 事件 + OPEN 拒絕呼叫 |
| 整合測試（mock server + fixtures） | ✅ 30 tests pass |

## 設計決策
- Envelope 契約違反（非 JSON/缺 _lineage/缺 data）不重試，直接拋 `McpEnvelopeError`（重試無意義）；僅 network/isError 類失敗重試
- `_lineage` 完整保留於 Envelope，為 T003 守門輸入
- breaker 以「call() 整體失敗」計數；cooldown 過後自動 half-open 試探恢復
