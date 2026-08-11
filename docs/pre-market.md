# 盤前選股邏輯（Phase 0 + Phase 1）

> 模組：`src/pre_market/`（T006）
> 規格：§4 Phase 0 / Phase 1

盤前選股是每個交易日的起點：**08:15 確認系統就緒，08:30 挑出當日候選標的**。
產出的候選清單不是最終交易決策——它只是「規則計算出觸發價與停損價」的素材，
方向鎖定（Bias）與戰術簡報（Briefing）由後續 T016/T019 承接。

---

## Phase 0：就緒檢查（08:15）

目的：確認開盤前一切可用，缺什麼提前暴露。

| 檢查項 | 內容 |
|--------|------|
| MCP 連線 | `tools/list` handshake，確認 MCP server 可通 |
| 必備工具 | 5 個：`get_institutional_investors`、`get_abnormal_trading`、`get_major_announcements`、`scan_daytrade_eligibility`、`set_active_watchlist` |
| 前一日盤後預熱 | 法人買賣超 / 異常成交量 / 重大訊息三工具，確認前一日盤後資料就緒（freshness == POST_MARKET_TODAY） |
| 資料缺口 | 任一工具未過守門 → 記入 `dataGaps`，於盤前報告註明並依 §3.2 降級 |

## Phase 1：三路徑選股（08:30）

### 選股池：三路徑合併 + 去重

| 路徑 | 資料源 | 挑選規則 |
|------|--------|----------|
| 法人同步買超 | `get_institutional_investors` | 投信 + 外資同步買超前 **20 檔**（`INSTITUTIONAL_TOP_N`） |
| 量能異常 | `get_abnormal_trading` | 異常成交量（注意股）清單 |
| 重大訊息 | `get_major_announcements` | 有重大公告的個股 |

三路徑取聯集並去重（`dedupe`），同一檔可有多個來源標記（`sources`）。

### 低訊號日降門檻

合併後若不足 **3 檔**（`targetMin`）→ 啟動 `fallbackExpand`：把法人買超前 N
從 20 檔擴大到 **30 檔**（`FALLBACK_TOP_N`）。仍不足 → 標記 `lowSignalDay: true`，
**不可硬湊**——寧可空手，不為交易而交易。

### 風控過濾

每檔候選跑 `scan_daytrade_eligibility`（買前風險掃描），剔除：

- 禁止當沖（`eligible === false`）
- 處置股 / 注意股
- 停資停券（`marginRestricted`）

### 候選計算（觸發價 / 停損價）

對通過過濾的標的，用 `get_stock_daily_kline`（昨日日 K）計算：

| 欄位 | 公式 | 意義 |
|------|------|------|
| `triggerPrice` 觸發價 | 昨日高點（`yesterdayHigh`） | 做多突破樞紐：站上昨日高點才觸發 |
| `stopLossPrice` 停損價 | `min(昨日收盤 × 0.985, VWAP 估計)` | 硬停損 **-1.5%** 或跌破 VWAP（**先觸發者**） |
| `flowScore` 籌碼分 | 法人路徑 25 分、其他 10 分 | 僅用於排序，非 Bias 評分 |
| `catalyst` 催化劑 | 來源標籤組合（法人同步買超 / 量能異常 / 重大訊息） | 敘事素材，LLM 潤飾由 §16 負責 |

VWAP 估計：以昨日 `(high + low + close) / 3` 典型價格近似。

### 排序與 Watchlist

1. 候選依 `flowScore` 遞減排序（`sortCandidates`）
2. 截斷至 **3–5 檔**（`targetMin`/`targetMax`）
3. 呼叫 `set_active_watchlist` 設定盤中監控清單（**≤ 15 檔**）；失敗 → 記入 `dataGaps` 並降級

### 產出 `PreMarketReport`

```ts
{
  date: '2026-08-12',
  connectionReady: true,
  dataGaps: [],                 // 缺口清單（守門失敗 / watchlist 失敗）
  candidates: [                 // 3–5 檔
    { symbol: '2308', direction: 'LONG', triggerPrice: 108.5,
      stopLossPrice: 104.6, yesterdayClose: 106.2, yesterdayHigh: 108.5,
      catalyst: '法人同步買超、量能異常', sources: ['INSTITUTIONAL','ABNORMAL'],
      flowScore: 35 },
  ],
  watchlist: ['2308', ...],     // ≤ 15 檔
  lowSignalDay: false,
  generatedAt: '2026-08-12T00:30:00.000Z',
}
```

## 設計要點（為什麼這樣做）

- **三路徑互補**：法人籌碼（中線資金）、量能異常（短線人氣）、重大訊息（事件驅動）——單一路徑可能漏掉題材，三路徑交集去重後覆蓋更全。
- **低訊號日不硬湊**：行情平淡時寧可空手。這是紀律，不是缺陷（模擬盤輸出會以警示提示）。
- **觸發價/停損價全部規則化**：不用主觀猜點位，昨日高點 + 硬停損 -1.5% 或 VWAP 先觸發，全部可回測可驗證。
- **風控前移**：當沖資格在盤前就掃完，盤中不再被注意股/處置股絆倒。

## 相關文件

- 盤中如何用這些候選 → [盤中監控與四條件評分](scoring.md)
- 候選如何被 Bias 鎖定 → `src/bias/decision_tree.ts`（§5）
- 候選如何變成戰術簡報 → [策略簡報（Briefing）](briefing.md)
