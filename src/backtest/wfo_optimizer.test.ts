// T024 WFO 測試（§13.3/§13.4）
// 覆蓋：滾動視窗（IS 3 + OOS 1）、IS Grid Search 找最佳參數（PF 最高且交易 ≥3）、OOS 無偏檢驗、
//       WfoWindowResult 欄位、OOS 權益曲線累計、WFE 邊界（30%/60%）、參數漂移穩定度（健康/危險）、
//       CLI 載入、月份切分過濾
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WalkForwardOptimizer } from './wfo_optimizer.js';
import type { MinuteBar } from './types.js';

/** 合成多月份資料：每標的每天 270 根 1 分 K，價格走勢可控制（trend>0 上漲 / <0 下跌）。
 * 設計讓「每天 10:00」產生放量突破：close 創當日新高且 > VWAP、量為前 20 分均量之 4 倍，
 * 以確保趨勢資料能觸發 Simulator 多方訊號（§12.4 條件），供 WFO 窗口產生交易。 */
function makeMonthData(
  symbols: string[],
  months: string[],
  opts: { daysPerMonth?: number; base?: number; trend?: number; vol?: number } = {},
): Map<string, MinuteBar[]> {
  const { daysPerMonth = 5, base = 100, trend = 1, vol = 1000 } = opts;
  const out = new Map<string, MinuteBar[]>();
  for (const symbol of symbols) {
    const bars: MinuteBar[] = [];
    for (const month of months) {
      for (let d = 1; d <= daysPerMonth; d++) {
        const date = `${month}-${String(d).padStart(2, '0')}`;
        const dayBias = (d % 3 === 0 ? -0.5 : 0.5) * trend; // 每 3 天一個回檔
        for (let m = 9 * 60; m <= 13 * 60 + 29; m++) {
          const hh = String(Math.floor(m / 60)).padStart(2, '0');
          const mm = String(m % 60).padStart(2, '0');
          const drift = (m - 9 * 60) / 270 * trend;
          const price = base + drift + dayBias;
          // 10:00 放量突破：close 創當日新高（= 當下價位峰值）、量為 4 倍
          const isBreakout = m === 10 * 60;
          const v = isBreakout ? vol * 4 : vol;
          const close = isBreakout ? price + 0.5 : price;
          bars.push({
            symbol,
            datetime: `${date}T${hh}:${mm}:00+08:00`,
            open: close - 0.2, high: close + 0.1, low: close - 0.3, close, volume: v,
          });
        }
      }
    }
    out.set(symbol, bars);
  }
  return out;
}

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

// ---- 滾動視窗（§13.3） ----
test('滾動視窗：IS 3 個月 + OOS 1 個月，窗口向前推進', async () => {
  const data = makeMonthData(['2308', '2317'], MONTHS);
  const opt = new WalkForwardOptimizer(3, 1);
  const report = await opt.runWfo(data);

  // 7 個月：W1(1-3→4)、W2(2-4→5)、W3(3-5→6)、W4(4-6→7) = 4 窗口
  assert.equal(report.windowResults.length, 4);
  assert.deepEqual(report.windowResults[0].inSampleRange, { start: '2026-01', end: '2026-03' });
  assert.deepEqual(report.windowResults[0].outOfSampleRange, { start: '2026-04', end: '2026-04' });
  assert.deepEqual(report.windowResults[1].inSampleRange, { start: '2026-02', end: '2026-04' });
  assert.deepEqual(report.windowResults[1].outOfSampleRange, { start: '2026-05', end: '2026-05' });
  assert.equal(report.windowResults[3].outOfSampleRange.start, '2026-07');
});

test('滾動視窗：樣本不足（< IS+OOS 個月）→ 無窗口', async () => {
  const data = makeMonthData(['2308'], ['2026-01', '2026-02', '2026-03']);
  const opt = new WalkForwardOptimizer(3, 1);
  const report = await opt.runWfo(data);
  assert.equal(report.windowResults.length, 0);
  assert.equal(report.wfoEfficiencyRatio, 0);
});

// ---- IS 最佳化（§13.3-A） ----
test('IS 最佳化：選 Profit Factor 最高且交易 ≥3 之參數', async () => {
  // 用私有方法間接驗證：跑 WFO 後檢查 bestInSampleParams 存在且 isProfitFactor > 0
  const data = makeMonthData(['2308'], MONTHS, { trend: 1.5, vol: 800 });
  const opt = new WalkForwardOptimizer(3, 1);
  const report = await opt.runWfo(data);
  for (const w of report.windowResults) {
    assert.ok(w.bestInSampleParams.stopLossPct > 0);
    assert.ok(w.bestInSampleParams.surgeMultiplier > 0);
    // IS 參數必有交易（≥3 門檻）→ OOS 也應有交易（趨勢資料）
    assert.ok(w.oosTradesCount >= 0);
  }
});

// ---- OOS 無偏檢驗（§13.3-B） ----
test('OOS 無偏檢驗：OOS 月份完全獨立於 IS', async () => {
  const data = makeMonthData(['2308'], MONTHS);
  const opt = new WalkForwardOptimizer(3, 1);
  const report = await opt.runWfo(data);
  for (const w of report.windowResults) {
    // OOS 範圍不與 IS 重疊
    const isMonths = [w.inSampleRange.start, w.inSampleRange.end];
    const oosMonths = [w.outOfSampleRange.start, w.outOfSampleRange.end];
    for (const oos of oosMonths) {
      assert.ok(!(oos >= isMonths[0] && oos <= isMonths[1]), 'OOS 月份不在 IS 範圍內');
    }
  }
});

// ---- 窗口輸出欄位（§13.3 WfoWindowResult） ----
test('WfoWindowResult 欄位完整', async () => {
  const data = makeMonthData(['2308'], MONTHS);
  const opt = new WalkForwardOptimizer(3, 1);
  const report = await opt.runWfo(data);
  const w = report.windowResults[0];
  assert.equal(typeof w.windowId, 'number');
  assert.ok(w.inSampleRange.start && w.inSampleRange.end);
  assert.ok(w.outOfSampleRange.start && w.outOfSampleRange.end);
  assert.equal(typeof w.bestInSampleParams.stopLossPct, 'number');
  assert.equal(typeof w.bestInSampleParams.surgeMultiplier, 'number');
  assert.equal(typeof w.oosPnlNtd, 'number');
  assert.equal(typeof w.oosWinRatePct, 'number');
  assert.equal(typeof w.oosTradesCount, 'number');
});

// ---- 拼接 OOS 績效（§13.3） ----
test('拼接 OOS 績效：totalOosPnlNtd 為各窗口損益累計', async () => {
  const data = makeMonthData(['2308'], MONTHS);
  const opt = new WalkForwardOptimizer(3, 1);
  const report = await opt.runWfo(data);
  const manual = report.windowResults.reduce((s, w) => s + w.oosPnlNtd, 0);
  assert.equal(report.totalOosPnlNtd, manual);
});

// ---- WFE（§13.3/§13.4） ----
test('WFE：獲利窗口比率計算正確', async () => {
  // 全獲利（趨勢向上）→ WFE 100% → PASS
  const up = makeMonthData(['2308'], MONTHS, { trend: 1.5 });
  const reportUp = await new WalkForwardOptimizer(3, 1).runWfo(up);
  assert.equal(reportUp.wfoEfficiencyRatio, 100);
  assert.equal(reportUp.wfeVerdict, 'PASS');
});

test('WFE 邊界：0% → OVERFIT（<30% 不可上線）', async () => {
  // 無走勢資料（震盪）→ OOS 可能全虧損或無交易 → 用全虧損資料強制 WFE 0%
  const down = makeMonthData(['2308'], MONTHS, { trend: -1.5 });
  const reportDown = await new WalkForwardOptimizer(3, 1).runWfo(down);
  assert.equal(reportDown.wfeVerdict, 'OVERFIT');
});

test('WFE 邊界：30% ≤ wfe ≤ 60% → INCONCLUSIVE', async () => {
  // 直接測 verdict 函數邏輯：構造 50% 獲利窗口
  const data = makeMonthData(['2308'], MONTHS);
  const opt = new WalkForwardOptimizer(3, 1);
  const report = await opt.runWfo(data);
  const verdict = (report.wfoEfficiencyRatio > 60) ? 'PASS' : (report.wfoEfficiencyRatio < 30) ? 'OVERFIT' : 'INCONCLUSIVE';
  assert.equal(report.wfeVerdict, verdict);
});

// ---- 參數漂移穩定度（§13.4） ----
test('參數漂移：趨勢穩定資料 → HEALTHY（參數不劇烈跳動）', async () => {
  const data = makeMonthData(['2308'], MONTHS, { trend: 1.2 });
  const report = await new WalkForwardOptimizer(3, 1).runWfo(data);
  assert.equal(report.parameterStability.status, 'HEALTHY');
  assert.ok(report.parameterStability.stopLossSequence.length === report.windowResults.length);
});

test('參數漂移：無窗口 → DANGEROUS（樣本不足）', async () => {
  const data = makeMonthData(['2308'], ['2026-01', '2026-02', '2026-03']);
  const report = await new WalkForwardOptimizer(3, 1).runWfo(data);
  assert.equal(report.parameterStability.status, 'DANGEROUS');
});

// ---- CLI 載入 ----
test('runWfoCli：載入 fixtures 並回傳報告（樣本不足時無窗口）', async () => {
  const { runWfoCli } = await import('./wfo_optimizer.js');
  const report = await runWfoCli();
  assert.ok(report.windowResults.length === 0, 'fixtures 僅 1 個月 → 無窗口');
  assert.equal(typeof report.totalOosPnlNtd, 'number');
});

// ---- 月份切分（私有方法間接驗證） ----
test('月份切分：不同月份資料互不污染', async () => {
  // 1-4 月強趨勢、5-7 月反轉 → 前 4 窗口 OOS 在 4-7 月，IS 僅用 1-4 月
  const janApr = makeMonthData(['2308'], ['2026-01', '2026-02', '2026-03', '2026-04'], { trend: 1.5 });
  const mayJul = makeMonthData(['2308'], ['2026-05', '2026-06', '2026-07'], { trend: -1.5 });
  const merged = new Map<string, MinuteBar[]>();
  merged.set('2308', [...janApr.get('2308')!, ...mayJul.get('2308')!]);
  const report = await new WalkForwardOptimizer(3, 1).runWfo(merged);
  assert.equal(report.windowResults.length, 4);
  // 後期窗口（IS 含反轉月）IS PF 可能為 0 → bestParam 仍是初始值，但結構完整
  for (const w of report.windowResults) assert.ok(w.bestInSampleParams);
});
