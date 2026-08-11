# Priority Ranking 排序 + 風控審核

> 模組：`src/execution/priority_engine.ts`（T020）
> 規格：§10 優先權排序與動態資金分配

盤中可能**同一個 tick 多檔同時觸發訊號**——但資金有限、風控有上限。
Priority Ranking Engine 決定：**誰先下單、給多少錢、誰被拒絕**。

---

## 三層流程（§10.1）

```
第一層  盤前戰術評級  →  Briefing 白名單 + 評分（決定 Tier）
第二層  盤中即時動能  →  Rank Score（爆量 × 偏離 × 盤前分）
第三層  資金池風控配額 →  總曝光 / 族群 40% / 1 張最低門檻
```

## evaluateSignal：下單前的 8 道關卡

每筆訊號依序檢查，任一關不過即拒絕（回 `ExecutionDecision { approved: false, reason }`）：

| 關卡 | 檢查 | 拒絕條件 |
|------|------|----------|
| 1. 白名單 | `candidate.action` 是否在 `briefing.trading_plan.allowed_actions` | Action 被 Briefing 阻擋（如 LONG_ONLY 日出現 SELL_TO_OPEN） |
| 2. 檔數上限 | 同時持倉數 < `MAX_POSITIONS`（預設 2） | 已達最大同時持倉檔數 |
| 3. 總曝光 | 目前總曝光 < `maxPortfolioExposureNtd`（資金池 × 槓桿） | 已達全系統當沖最大總曝光上限 |
| 4. Rank Score | 綜合優先權得分（見下） | — |
| 5. Tier 資金 | `tierCapitalForScore()` 配額 > 0 | 盤前評級 < 50 → Tier 4 禁止交易 |
| 6. 族群集中度 | 同族群在手持倉 ≤ 總曝光 × `SECTOR_LIMIT_PCT`（40%） | 同族群額度已滿 |
| 7. 最終配額 | `min(Tier 上限, 族群剩餘, 系統剩餘)` | — |
| 8. 1 張門檻 | 配額 ≥ 1 張成本（價 × 1000 股） | 剩餘配額不足以買進 1 張 |

## Rank Score（§10.1）

```ts
computeRankScore(preMarketScore, volumeSurgeRatio, vwapDeviationPct,
                { wBias: 0.4, wSurge: 0.5, wDist: 0.1 }, surgeCap = 5)

= 0.4 × 盤前分 + 0.5 × min(爆量倍數 × 20, 5 × 20) − 0.1 × 偏離% × 15
```

| 成分 | 權重 | 說明 |
|------|------|------|
| 盤前評級（Bias score） | 0.4 | 盤前決定方向的信心度（SHORT_ONLY 取絕對值） |
| 爆量倍數 | 0.5 | 盤中即時動能，5 倍爆量封頂得 100 分（`surgeCap`） |
| VWAP 偏離 | 0.1 | 偏離過高扣分（追太遠的訊號不值得排前面） |

## Tier 資金配置（§10.2，資金池 300 萬、槓桿 2 倍 → 總曝光 600 萬）

| 盤前評級分數 | Tier | 資金上限（佔資金池） |
|------------|------|---------------------|
| ≥ 80 | Tier 1 | 33% |
| ≥ 60 | Tier 2 | 20% |
| ≥ 50 | Tier 3 | 10% |
| < 50 | Tier 4 | **拒絕** |

## 競爭搶單（§10.4）

同 tick 多訊號：`rank()` 依 Rank Score 遞減排序，**依序派單**。
先派的先吃資金，後派的若資金不足 1 張 → 拒絕。決策寫入 `priority_ranked`
事件（含 `rankScore` / `allocatedCapital` / `reason`），全鏈路可回放。

## 持倉生命週期

| 方法 | 時機 | 作用 |
|------|------|------|
| `registerPosition(symbol, capital, sector)` | 下單成功後 | 佔用資金 + 記錄族群 |
| `releasePosition(symbol)` | 平倉後 | 釋放資金與族群額度 |
| `releaseAllPositions()` | 每交易日 / 每迭代重置 | 清空全部持倉 |

## 設計要點

- **多關卡 = 多道保險**：白名單管方向、檔數管分散、總曝光管槓桿、族群管集中度、1 張管碎單——每一關都是獨立風控維度。
- **Rank 不是預測**：它只在「多個訊號都合法」時排序——誰的資金效率高誰先，不是誰的勝率高誰先。
- **Tier 與族群 40% 是防爆倉核心**：單一標的或單一族群再強，也吃不完整個資金池。

## 相關文件

- 白名單與動態風控參數從哪來 → [策略簡報（Briefing）](briefing.md)
- 訊號如何產生 → [盤中監控與四條件評分](scoring.md)
- 資金池與風控參數設定 → `src/config/env_defaults.ts`（§17.1）
