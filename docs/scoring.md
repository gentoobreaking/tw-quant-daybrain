# 盤中監控與四條件評分

> 模組：`src/engine/scoring.ts`（T007）+ `src/engine/intraday_loop.ts`（T009）
> 規格：§8 Config-Driven 評分

盤中（09:00–12:30）每 **10 秒** 一個 tick：VWAP 計算 + 爆量偵測 + **雙 tick 確認** +
四條件評分。評分通過才產生訊號（`SignalAdvice`），訊號 5 分鐘內未觸發進場價則過期重評。

---

## 四條件評分（4 × 25 分 = 100 分）

評分權重定義於 `config/scoring.yaml`（Config-Driven，可版本化；`scoring_version`
寫入每筆訊號）。四條件各 25 分，**做多 / 做空條件對稱**：

| 條件 | 權重 | 做多（LONG）得分條件 | 做空（SHORT）得分條件 |
|------|------|---------------------|----------------------|
| **位階** position | 25 | 價 > VWAP | 價 < VWAP |
| **量能** volume | 25 | 爆量倍數 ≥ 門檻（2.5×） | 空方爆量破位（BEARISH_BREAKDOWN） |
| **突破** breakout | 25 | 價 ≥ 當日高點 | 價 < 開盤前 15 分鐘低點 |
| **大盤方向** market | 25 | 台指期 1 分 K 紅棒（BULLISH） | 台指期 1 分 K 黑棒（BEARISH） |

## 風控 Veto（優先於評分）

| Veto | 對象 | 處罰 | 性質 |
|------|------|------|------|
| 距漲停 < 1.5% | 多方 | **-50** | 扣分（利潤空間不足），非否決 |
| 今日漲幅 ≥ 6.5% | 空方 | **-100** | 否決（防軋空鎖死） |
| 處置 / 注意 / 當沖限制 / 停資停券 | 通用 | **-100** | 否決 |

**Veto 優先邏輯**：`-100` 直接否決（`shouldEnter = false`，總分 -100）；
`-50` 併入總分計算（扣分但可繼續）。

## 門檻與等級（§8.3）

| 總分 | 等級 | 動作 |
|------|------|------|
| ≥ 75（`strong_buy`） | STRONG_BUY / STRONG_SELL | 進場（`shouldEnter = true`） |
| 60–74（`watch`） | WATCH | 僅記錄，不進場 |
| < 60 | IGNORE | 忽略 |

> **NEUTRAL_FLEXIBLE 日**：進場門檻提高至 **85 分**（`neutral_flexible_override`）——
> 雙向可做時要求更高確認度。

## 評分輸入（ScoreInput）

```ts
{
  direction: 'LONG' | 'SHORT',
  price: 107.5,              // 目前價
  vwap: 106.2,               // 當日 VWAP
  volumeSurgeRatio: 3.2,     // 爆量倍數（近 20 分均量滑動窗口比對）
  volumeSurgeType: 'BULLISH_SURGE' | 'BEARISH_BREAKDOWN',
  dayHigh: 108.0,            // 當日高點
  dayLow15m: 105.1,          // 開盤前 15 分鐘低點
  taifexTrend: 'BULLISH' | 'BEARISH',  // 台指期 1 分 K 方向
  distanceToLimitUpPct: 0.02,  // 距漲停幅度（多方向 veto 用）
  dayGainPct: 0.03,            // 今日漲幅（空方向 veto 用）
  restriction: false,          // 處置/注意/當沖限制
}
```

## 產出（ScoreResult）

```ts
{
  total: 85,                    // 總分（Veto 否決時 = -100）
  breakdown: { level: 25, volume: 25, breakout: 25, market: 0, veto_penalty: 0 },
  grade: 'STRONG_BUY',
  veto_reasons: [],             // 觸發的 veto 原因（人話）
  shouldEnter: true,
  scoring_version: '2.1.0',
}
```

## 訊號生命週期（intraday_loop）

1. **雙 tick 確認**（`TickConfirmer(2)`）：同一標的連續兩次 tick 都符合才進入完整評分——防單筆瞬間雜訊
2. **評分**：`SignalScoringEngine.score()` 四條件 + Veto → `shouldEnter`
3. **產生 SignalAdvice**：含完整執行計劃
   ```
   signal_id: 20260812-0930-12345
   進場 106.20｜停損 104.61（-1.5%）｜目標 109.39（+3%）｜RR 2.0｜倉位 941 股
   ```
4. **寫入事件**：`signal_issued`（含執行計劃欄位，供回放）
5. **過期重評**：訊號產生後 **5 分鐘**（`signal_expiry_min`）未觸發進場價 → 過期刪除

## 設計要點

- **四條件互相獨立**：位階/量能/突破/大盤各 25 分——單一條件再好也拿不到 100 分，避免「漲很多就追」的單因子陷阱。
- **Veto 是風控不是評分**：評分管「該不該做」，Veto 管「能不能做」——被處置/注意的標的評分再高也進不來。
- **門檻可調**：全部在 scoring.yaml 集中管理，Grid Search 可直接掃門檻/權重，回測友好。
- **雙 tick 防雜訊**：10 秒 tick 的高頻環境，單筆 tick 可能是瞬間報價，兩次確認才可信。

## 相關文件

- 候選標的從哪來 → [盤前選股邏輯](pre-market.md)
- 評分通過後如何排隊下單 → [Priority Ranking 與風控審核](priority-ranking.md)
- 評分參數如何調優 → README 情境 C（grid-search / wfo）
