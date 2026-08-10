// T023 Grid Search 測試（§13.1/§13.2）
// 覆蓋：42 組合完整搜尋（T013 fixtures）、無效組合過濾（<5 交易）、依淨利潤排序、Top 5、
//       進度輸出（\r覆寫）、高原判讀、孤島警示、每次迭代全新 Simulator（狀態不殘留）、CLI 載入
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { CsvDataLoader } from './data_loader.js';
import {
  GridSearchRunner,
  STOP_LOSS_OPTIONS,
  SURGE_OPTIONS,
  makeGridBriefing,
  defaultBriefingTemplate,
  identifyPlateau,
  runGridSearchCli,
} from './grid_search.js';
import { DayBrainBacktestSimulator } from './simulator.js';
import type { MinuteBar } from './types.js';

async function loadFixtures(): Promise<Map<string, MinuteBar[]>> {
  const loader = new CsvDataLoader({ volumeUnit: 'LOTS' });
  const dir = path.join(process.cwd(), 'testdata', 'historical_1m');
  return loader.loadDirectory(dir);
}

// ---- 搜尋空間（§13.1） ----
test('搜尋空間：停損 7 檔 × 爆量 6 檔 = 42 組合', () => {
  assert.deepEqual(STOP_LOSS_OPTIONS, [1.0, 1.2, 1.5, 1.8, 2.0, 2.2, 2.5]);
  assert.deepEqual(SURGE_OPTIONS, [2.0, 2.5, 3.0, 3.5, 4.0, 5.0]);
  assert.equal(STOP_LOSS_OPTIONS.length * SURGE_OPTIONS.length, 42);
});

// ---- 完整搜尋（T013 fixtures） ----
test('完整搜尋：T013 fixtures 跑 42 組合，無拋錯且進度完整', async () => {
  const marketData = await loadFixtures();
  assert.ok(marketData.size >= 2, 'fixtures 有標的');

  let progress = 0;
  const runner = new GridSearchRunner({ onProgress: (completed, total) => { progress = completed; assert.ok(completed <= total); } });
  const report = runner.run(marketData);

  assert.equal(report.meta.totalCombinations, 42);
  assert.equal(progress, 42, '進度到達 42/42');
  assert.equal(report.results.length, report.meta.validCombinations);
  // 依淨利潤降冪
  for (let i = 1; i < report.results.length; i++) {
    assert.ok(report.results[i - 1].netTotalPnlNtd >= report.results[i].netTotalPnlNtd, '依淨利潤降冪排序');
  }
  // 無效組合過濾：全部 ≥5 交易
  for (const r of report.results) assert.ok(r.totalTrades >= 5, `交易次數 ≥5（實際 ${r.totalTrades}）`);
  // Top 5 輸出欄位
  const top5 = report.results.slice(0, 5);
  for (const r of top5) {
    assert.equal(typeof r.stopLossPct, 'number');
    assert.equal(typeof r.surgeMultiplier, 'number');
    assert.equal(typeof r.winRatePct, 'number');
    assert.equal(typeof r.profitFactor, 'number');
  }
  assert.ok(report.results.length <= 42);
});

// ---- 每迭代全新 Simulator（§13.1） ----
test('每次迭代全新 Simulator：狀態不殘留', async () => {
  const marketData = await loadFixtures();
  // 用 spy 檢查 Simulator 每次都重新 new（無法直接 spy，改驗證兩次執行結果一致）
  const runner = new GridSearchRunner();
  const r1 = runner.run(marketData);
  const r2 = runner.run(marketData);
  assert.deepEqual(r1.results, r2.results, '兩次執行結果一致（無跨迭代狀態殘留）');
});

// ---- makeGridBriefing（§13.1 參數注入） ----
test('makeGridBriefing：注入 hard_stop_loss_pct / volume_surge_threshold', () => {
  const b = makeGridBriefing('2308', { stopLossPct: 1.8, surgeMultiplier: 2.5 }, defaultBriefingTemplate());
  assert.equal(b.target.symbol, '2308');
  assert.equal(b.risk_guardrails.hard_stop_loss_pct, 1.8);
  assert.equal(b.trading_plan.key_levels.volume_surge_threshold, 2.5);
  // 其餘欄位保留模板值
  assert.equal(b.risk_guardrails.take_profit_target_1_pct, 2.0);
  assert.equal(b.bias_assessment.bias, 'LONG_ONLY');
});

// ---- 獲利高原判讀（§13.2） ----
test('獲利高原判讀：連續停損區間被標為高原，孤島被警示', () => {
  const mk = (sl: number, surge: number, pnl: number, trades: number): GridSearchResult => ({
    stopLossPct: sl, surgeMultiplier: surge, totalTrades: trades,
    winRatePct: 60, netTotalPnlNtd: pnl, profitFactor: 2.0, onPlateau: false,
  });
  // 高原：Surge 2.5 × SL 1.5–2.0 連續高利潤（各 10 萬+）
  const results = [
    mk(1.0, 2.5, 80000, 40),
    mk(1.2, 2.5, 90000, 38),
    mk(1.5, 2.5, 138000, 52),
    mk(1.8, 2.5, 142500, 48),
    mk(2.0, 2.5, 135200, 45),
    mk(2.2, 2.5, 92000, 41),
    mk(1.2, 4.0, 130000, 12), // 孤島：高利潤但交易銳減（過門檻但不在高原）
    mk(1.5, 4.0, 40000, 30),
  ].sort((a, b) => b.netTotalPnlNtd - a.netTotalPnlNtd);

  const { plateau, islands } = identifyPlateau(results, 0.85);
  assert.ok(plateau !== null, '有高原');
  assert.match(plateau!, /Surge 2.5/);
  assert.match(plateau!, /SL 1.5–2.0/);
  // 孤島：SL 1.2 × Surge 4.0（交易 12 ≤ 高原平均 48×0.5）
  assert.ok(islands.some((i) => i.stopLossPct === 1.2 && i.surgeMultiplier === 4.0), '孤島被標出');
});

test('獲利高原判讀：無正利潤 → plateau null 且無孤島', () => {
  const { plateau, islands } = identifyPlateau([
    { stopLossPct: 1.0, surgeMultiplier: 2.0, totalTrades: 6, winRatePct: 20, netTotalPnlNtd: -5000, profitFactor: 0.5, onPlateau: false },
    { stopLossPct: 1.5, surgeMultiplier: 2.5, totalTrades: 7, winRatePct: 25, netTotalPnlNtd: -3000, profitFactor: 0.7, onPlateau: false },
  ], 0.85);
  assert.equal(plateau, null);
  assert.deepEqual(islands, []);
});

// ---- 無效組合過濾 ----
test('無效組合過濾：交易 < 5 被濾除（minTrades 參數）', async () => {
  const marketData = await loadFixtures();
  const runner = new GridSearchRunner({ minTrades: 10 });
  const report = runner.run(marketData);
  for (const r of report.results) assert.ok(r.totalTrades >= 10);
});

// ---- CLI 載入（npm run grid-search） ----
test('runGridSearchCli：載入 fixtures 並回傳報告', async () => {
  const dir = path.join(process.cwd(), 'testdata', 'historical_1m');
  const report = await runGridSearchCli(dir);
  assert.equal(report.meta.totalCombinations, 42);
  assert.ok(report.meta.dataSymbols >= 2);
  assert.ok(report.meta.dataBars > 0);
  assert.equal(typeof report.recommendation, 'object');
});

// ---- Simulator 直接整合（確認 grid 注入會改變結果） ----
test('Simulator 整合：不同 surge threshold 產生不同交易數', async () => {
  const marketData = await loadFixtures();
  const sim1 = new DayBrainBacktestSimulator();
  sim1.loadBriefings([makeGridBriefing('2308', { stopLossPct: 1.5, surgeMultiplier: 2.0 }, defaultBriefingTemplate())]);
  const r1 = sim1.runSimulation(marketData);

  const sim2 = new DayBrainBacktestSimulator();
  sim2.loadBriefings([makeGridBriefing('2308', { stopLossPct: 1.5, surgeMultiplier: 5.0 }, defaultBriefingTemplate())]);
  const r2 = sim2.runSimulation(marketData);

  assert.ok(r1.summary.total_trades >= r2.summary.total_trades, '低 threshold 交易數 ≥ 高 threshold');
});
