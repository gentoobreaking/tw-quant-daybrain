# 策略簡報（Tactical Briefing）

> 模組：`src/briefing/generator.ts`（T019）
> 規格：§9 Tactical Briefing

策略簡報是 **08:55 鎖定的「當日作戰計畫」**——把盤前的 Bias 決策（多/空/不交易）
結構化成一份帶資料出處（Data Lineage）的 JSON 狀態檔。它是盤中 Agent 的
**Action 白名單 + 動態風控參數的唯一來源**（不硬編碼），也是回測參數注入點。

---

## 簡報內容：一份 briefing.json 長什麼樣

| 區塊 | 欄位 | 說明 |
|------|------|------|
| `_lineage` | generated_at / agent_version / data_sources | 產出時間、版本、資料來源（含抓取時間） |
| `target` | symbol / name / market / yesterday_close | 標的基礎資料 |
| `bias_assessment` | bias / score / confidence / scoring_breakdown | Bias 決策樹結果：多/空/中性/不交易 + 分數 + 信心度 + 逐因子拆解 |
| `trading_plan` | allowed_actions / blocked_actions / active_window / key_levels | 允許動作、時間窗、關鍵價位 |
| `risk_guardrails` | 最大倉位 / 硬停損 / 目標價 / 移動停損 / 安全旗標 | 動態風控參數 |

### Bias 對應規則（§9.2）

| Bias | allowed_actions | 意義 |
|------|----------------|------|
| `NO_TRADE` | 空 | 不交易（盤中找不到簡報也視同 NO_TRADE） |
| `LONG_ONLY` | 僅 `BUY_TO_OPEN` | 只做多 |
| `SHORT_ONLY` | 僅 `SELL_TO_OPEN` | 只做空 |
| `NEUTRAL_FLEXIBLE` | 雙向 | 雙向都可，但進場門檻提高（85 分） |

### 動態時間窗

- `no_new_entry_after`：預設 11:30（SHORT_ONLY 日停新空單）
- `force_flat_by`：**SHORT_ONLY → 13:00**、其餘 → **13:10**（空單要提前回補）

### Key Levels（關鍵價位）

| 欄位 | 來源 |
|------|------|
| `anchor_vwap_estimate` | 前一日日 K 典型價 `(H+L+C)/3` |
| `breakout_pivot_price` | 昨日高點（突破樞紐） |
| `support_invalidation_price` | 支撐失效價（跌破即停損） |
| `volume_surge_threshold` | 爆量門檻（預設 2.5 倍；**Grid Search / WFO 的參數注入點**） |

---

## 如何查看所有策略簡報

### 簡報存檔位置

每份簡報寫入 **`<outputDir>/YYYY-MM-DD_SYMBOL.json`**，`outputDir` 預設為
專案根目錄的 `briefings/` 資料夾：

```
briefings/
  2026-08-10_2308.json      # 台達電當日簡報
  2026-08-10_2317.json      # 鴻海當日簡報
  2026-08-11_2308.json
```

### 查看方式

**方式 1：直接看檔案（最快）**

```bash
ls briefings/                    # 列出所有歷史簡報
cat briefings/2026-08-10_2308.json   # 看單日單檔簡報（JSON 格式化）
```

**方式 2：用 jq 查詢特定欄位**

```bash
# 看某天所有簡報的 bias 決策
for f in briefings/2026-08-10_*.json; do
  echo "$f: $(jq -r '.bias_assessment.bias' "$f") (score $(jq -r '.bias_assessment.score' "$f"))"
done

# 看某檔簡報的允許動作 + 強平時間
jq '{bias: .bias_assessment.bias, allowed: .trading_plan.allowed_actions, force_flat_by: .trading_plan.active_window.force_flat_by}' briefings/2026-08-10_2308.json
```

**方式 3：透過事件日誌回放**

每份簡報產出時寫入 `briefing_generated` 事件（含 `briefing_id = YYYY-MM-DD_SYMBOL`）：

```bash
grep briefing_generated logs/2026-08-10.events.jsonl   # 當日哪些標的產出了簡報
```

### 盤中載入（防呆機制）

盤中引擎用 `loadBriefing(outputDir, symbol, date)` 載入當日簡報：

- **找不到當日檔案 → 回 `null` → 拒絕啟動交易**（§9.3 防呆）
- 這保證「沒有計畫就不交易」——Bias 沒鎖定或簡報遺失時，寧可空手

---

## 設計要點

- **唯一真值**：盤中風控參數（停損/目標/時間窗/爆量門檻）全部來自簡報，程式碼不硬編碼——改參數就是改簡報，可版本化、可回測。
- **防呆優先**：盤中找不到簡報 = 當日 NO_TRADE，寧可錯過不可亂做。
- **可追溯**：每份簡報帶 `_lineage`（何時、哪個版本、用哪些資料產生），事後檢討能還原當日決策依據。

## 相關文件

- 簡報的 Bias 從哪來 → `src/bias/decision_tree.ts`（§5 盤前多空傾向鎖定）
- 簡報如何變成盤中訊號 → [盤中監控與四條件評分](scoring.md)
- 簡報的 allowed_actions 如何過濾下單 → [Priority Ranking 與風控審核](priority-ranking.md)
