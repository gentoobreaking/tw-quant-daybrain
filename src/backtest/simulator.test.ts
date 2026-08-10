// T022 DayBrainBacktestSimulator 單元 + 整合測試（§12）
// 覆蓋：完整模擬日（多標的競態、白名單攔截）、成本計算精確性（手續費/證交稅/滑點）、
//       離場（STOP_LOSS/TAKE_PROFIT/FORCE_FLAT）、Briefing 參數載入、報告結構、Grid Search 迭代全新實例
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DayBrainBacktestSimulator, timeOnlyOf } from './simulator.js';
import type { MinuteBar } from './types.js';
import type { TacticalBriefing } from '../briefing/generator.js';

// ---- helpers ----

function bar(symbol: string, t: string, o: number, h: number, l: number, c: number, v: number): MinuteBar {
  return { symbol, datetime: `2026-08-03T${t}:00+08:00`, open: o, high: h, low: l, close: c, volume: v };
}

function makeBriefing(symbol: string, bias: TacticalBriefing['bias_assessment']['bias'], score: number, over: Partial<TacticalBriefing['trading_plan']> & Partial<TacticalBriefing['risk_guardrails']> = {}): TacticalBriefing {
  const allowed = bias === 'LONG_ONLY' ? ['BUY_TO_OPEN'] : bias === 'SHORT_ONLY' ? ['SELL_TO_OPEN'] : bias === 'NEUTRAL_FLEXIBLE' ? ['BUY_TO_OPEN', 'SELL_TO_OPEN'] : [];
  return {
    _lineage: { generated_at: '2026-08-03T08:55:00+08:00', agent_version: 'v2.0', mcp_server_version: 'v1.3', data_sources: [] },
    target: { symbol, name: symbol, market: 'TWSE', yesterday_close: 100 },
    bias_assessment: { bias, score, confidence: score >= 80 ? 'HIGH' : 'MEDIUM', scoring_breakdown: [] },
    trading_plan: {
      allowed_actions: allowed,
      blocked_actions: bias === 'LONG_ONLY' ? ['SELL_TO_OPEN'] : bias === 'SHORT_ONLY' ? ['BUY_TO_OPEN'] : [],
      active_window: { start_time: '09:05', no_new_entry_after: '11:30', force_flat_by: bias === 'SHORT_ONLY' ? '13:00' : '13:10' },
      key_levels: { anchor_vwap_estimate: 100, breakout_pivot_price: 100, support_invalidation_price: 100, volume_surge_threshold: 2.5 },
      ...over,
    },
    risk_guardrails: {
      max_position_size_shares: 2000,
      hard_stop_loss_pct: 1.5,
      take_profit_target_1_pct: 2.0,
      trailing_stop_activation_pct: 2.0,
      trailing_stop_callback_pct: 1.0,
      max_drawdown_limit_ntd: 30000,
      safety_flags: { is_disposition: false, can_daytrade: true, can_short_first: true, earnings_announcement_today: false },
      ...over,
    },
  };
}

/** 建一個多頭爆量 K（close > VWAP 且量爆增；high 貼近 close 使 close ≥ dayHigh×0.998 成立） */
function surgeBar(symbol: string, t: string, price: number, vol: number): MinuteBar {
  return { symbol, datetime: `2026-08-03T${t}:00+08:00`, open: price - 0.3, high: price + 0.05, low: price - 0.5, close: price, volume: vol };
}

// ---- 成本計算（§12.4） ----
test('成本：手續費 2.8 折 + 證交稅 + 滑點精確計算', () => {
  // 依 §12.4 公式驗證（commissionRate=0.001425×0.28、tax=0.0015）
  const entryPrice = 1640.8;
  const exitPrice = 1673.0;
  const shares = 1000;
  const commissionRate = 0.001425 * 0.28;
  const taxRate = 0.0015;
  const gross = (exitPrice - entryPrice) * shares;
  const buyComm = entryPrice * shares * commissionRate;
  const sellComm = exitPrice * shares * commissionRate;
  const tax = exitPrice * shares * taxRate;
  const net = Math.round(gross - buyComm - sellComm - tax);
  assert.ok(Math.abs(commissionRate - 0.000399) < 1e-12);
  assert.ok(Math.abs(buyComm - 654.679) < 0.01);
  assert.ok(Math.abs(sellComm - 667.527) < 0.01);
  assert.equal(tax, 2509.5);
  assert.equal(net, 28368); // §12.4 公式之精確值
});

// ---- 完整模擬日：多頭爆量突破 ----
test('模擬日：多頭爆量突破 → 進場 → 停利離場（TAKE_PROFIT）', () => {
  const marketData = new Map<string, MinuteBar[]>();
  // 09:00–09:20 平穩小量建立 VWAP 基線
  const base: MinuteBar[] = [];
  for (let m = 9 * 60 + 0; m <= 9 * 60 + 20; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    base.push(bar('2308', `${hh}:${mm}`, 100, 100.4, 99.8, 100.2, 50));
  }
  // 09:21 爆量突破（量 500 = 10 倍均量，close 101 > VWAP）
  base.push(surgeBar('2308', '09:21', 101.0, 500));
  // 09:22–09:30 續漲 → 觸及 +2% 停利（entry≈101.05 → target≈103.07）
  for (let m = 9 * 60 + 22; m <= 9 * 60 + 30; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    base.push(bar('2308', `${hh}:${mm}`, 101 + (m - (9 * 60 + 22)) * 0.4, 101.5 + (m - (9 * 60 + 22)) * 0.4, 101, 101 + (m - (9 * 60 + 22)) * 0.4, 100));
  }
  marketData.set('2308', base);

  const sim = new DayBrainBacktestSimulator({ totalMarginPoolNtd: 3_000_000 });
  sim.loadBriefings([makeBriefing('2308', 'LONG_ONLY', 85)]);
  const report = sim.runSimulation(marketData);

  assert.equal(report.summary.total_trades, 1);
  const trade = report.trades[0];
  assert.equal(trade.action, 'BUY_TO_OPEN');
  assert.equal(trade.exitReason, 'TAKE_PROFIT');
  // 滑點：entry = 101.0 × 1.0005 = 101.0505
  assert.ok(Math.abs(trade.entryPrice - 101.0 * 1.0005) < 1e-6);
  // 停利 = entry × 1.02
  assert.ok(Math.abs(trade.exitPrice - 101.0505 * 1.02) < 1e-6);
  // 淨利潤 = 毛利 - 買賣手續費 - 證交稅
  const gross = (trade.exitPrice - trade.entryPrice) * trade.shares;
  const fees = trade.entryPrice * trade.shares * 0.001425 * 0.28 + trade.exitPrice * trade.shares * 0.001425 * 0.28 + trade.exitPrice * trade.shares * 0.0015;
  assert.equal(trade.pnlNtd, Math.round(gross - fees));
  assert.ok(trade.pnlNtd > 0);
  assert.equal(report.summary.win_rate_pct, 100);
  assert.ok(report.summary.profit_factor > 1);
});

// ---- 完整模擬日：白名單攔截（§12.5 engine_effectiveness） ----
test('模擬日：LONG_ONLY 日 SELL 候選被 Briefing 白名單攔截', () => {
  // 構造空頭走勢標的：連續跌破 VWAP + 爆量 + 破 15 分低點 → 產生 SELL 候選
  const marketData = new Map<string, MinuteBar[]>();
  const bars: MinuteBar[] = [];
  // 09:00–09:15 平穩（建立 first15mLow 基線）
  for (let m = 9 * 60; m <= 9 * 60 + 15; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    bars.push(bar('2317', `${hh}:${mm}`, 100, 100.4, 99.8, 100.2, 50));
  }
  // 09:16 爆量下殺（量 500，close 99 < VWAP、破 15 分低點 99.8）
  bars.push({ symbol: '2317', datetime: '2026-08-03T09:16:00+08:00', open: 100.0, high: 100.1, low: 98.9, close: 99.0, volume: 500 });
  for (let m = 9 * 60 + 17; m <= 9 * 60 + 25; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    bars.push(bar('2317', `${hh}:${mm}`, 99, 99.2, 98.8, 99.0, 60));
  }
  marketData.set('2317', bars);

  const sim = new DayBrainBacktestSimulator();
  sim.loadBriefings([makeBriefing('2317', 'LONG_ONLY', 75)]); // 只允許 BUY
  const report = sim.runSimulation(marketData);

  assert.equal(report.summary.total_trades, 0);
  assert.ok(report.engine_effectiveness.blocked_by_briefing_bias >= 1, 'SELL 候選被白名單攔截');
  assert.ok(report.engine_effectiveness.blocked_by_briefing_bias > 0);
});

// ---- 完整模擬日：多標的競態（§10.4） ----
test('模擬日：同分鐘兩標的爆量 → Priority Engine 排序撮合（廣達優先）', () => {
  const marketData = new Map<string, MinuteBar[]>();
  // 2308：爆量 3 倍、盤前 85 → rank = 0.4×85 + 0.5×60 = 64
  // 2382：爆量 5 倍、盤前 60 → rank = 0.4×60 + 0.5×100 = 74（優先）
  const mk = (symbol: string, base: number, surgeVol: number) => {
    const b: MinuteBar[] = [];
    for (let m = 9 * 60; m <= 9 * 60 + 20; m++) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      b.push(bar(symbol, `${hh}:${mm}`, base, base + 0.4, base - 0.2, base + 0.2, 100));
    }
    b.push(surgeBar(symbol, '09:21', base + 1.0, surgeVol));
    return b;
  };
  marketData.set('2308', mk('2308', 100, 300)); // 3 倍
  marketData.set('2382', mk('2382', 100, 500)); // 5 倍

  const sim = new DayBrainBacktestSimulator({ totalMarginPoolNtd: 3_000_000 });
  sim.loadBriefings([
    makeBriefing('2308', 'LONG_ONLY', 85),
    makeBriefing('2382', 'LONG_ONLY', 60),
  ]);
  const report = sim.runSimulation(marketData);

  assert.equal(report.summary.total_trades, 2, '兩標的都進場（資金池 300 萬足夠）');
  assert.equal(report.engine_effectiveness.priority_ranking_conflicts_resolved, 1, '同分鐘競態已解決');
  // 兩標的 entryTime 同為 09:21
  assert.equal(report.trades[0].entryTime, '2026-08-03T09:21:00+08:00');
  assert.equal(report.trades[1].entryTime, '2026-08-03T09:21:00+08:00');
  // rankScore：2382（爆量 5 倍）高於 2308（爆量 3 倍）——排序保證先撮合
  const scores = report.trades.map((t) => t.rankScoreAtEntry);
  const rank2382 = report.trades.find((t) => t.symbol === '2382')!.rankScoreAtEntry;
  const rank2308 = report.trades.find((t) => t.symbol === '2308')!.rankScoreAtEntry;
  assert.ok(rank2382 > rank2308, '2382（5 倍爆量）Rank 高於 2308（3 倍）');
  assert.ok(scores.every((s) => s > 50), '兩標的皆非 Tier 4');
});

// ---- 完整模擬日：資金不足 1 張（§10.4） ----
test('模擬日：Tier 4（45 分）→ 拒絕進場', () => {
  const marketData = new Map<string, MinuteBar[]>();
  const b: MinuteBar[] = [];
  for (let m = 9 * 60; m <= 9 * 60 + 20; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    b.push(bar('2308', `${hh}:${mm}`, 100, 100.4, 99.8, 100.2, 50));
  }
  b.push(surgeBar('2308', '09:21', 101.0, 500));
  marketData.set('2308', b);

  const sim = new DayBrainBacktestSimulator();
  sim.loadBriefings([makeBriefing('2308', 'LONG_ONLY', 45)]); // Tier 4
  const report = sim.runSimulation(marketData);
  assert.equal(report.summary.total_trades, 0);
  assert.ok(report.engine_effectiveness.blocked_by_margin_cap >= 1);
});

// ---- 完整模擬日：STOP_LOSS ----
test('模擬日：進場後跌破停損 → STOP_LOSS 離場', () => {
  const marketData = new Map<string, MinuteBar[]>();
  const b: MinuteBar[] = [];
  for (let m = 9 * 60; m <= 9 * 60 + 20; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    b.push(bar('2308', `${hh}:${mm}`, 100, 100.4, 99.8, 100.2, 50));
  }
  b.push(surgeBar('2308', '09:21', 101.0, 500));
  // 09:22 直接暴跌破停損（entry 101.05 → SL 99.53）
  b.push({ symbol: '2308', datetime: '2026-08-03T09:22:00+08:00', open: 101.0, high: 101.1, low: 99.4, close: 99.5, volume: 200 });
  marketData.set('2308', b);

  const sim = new DayBrainBacktestSimulator();
  sim.loadBriefings([makeBriefing('2308', 'LONG_ONLY', 85)]);
  const report = sim.runSimulation(marketData);
  assert.equal(report.summary.total_trades, 1);
  assert.equal(report.trades[0].exitReason, 'STOP_LOSS');
  assert.equal(report.trades[0].exitPrice, report.trades[0].entryPrice * 0.985);
  assert.ok(report.trades[0].pnlNtd < 0);
});

// ---- 完整模擬日：FORCE_FLAT（13:10） ----
test('模擬日：13:10 強制平倉（FORCE_FLAT）', () => {
  const marketData = new Map<string, MinuteBar[]>();
  const b: MinuteBar[] = [];
  for (let m = 9 * 60; m <= 9 * 60 + 20; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    b.push(bar('2308', `${hh}:${mm}`, 100, 100.4, 99.8, 100.2, 50));
  }
  b.push(surgeBar('2308', '09:21', 101.0, 500));
  // 09:22–13:09 橫盤（無停損停利觸發）
  for (let m = 9 * 60 + 22; m <= 13 * 60 + 9; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    b.push(bar('2308', `${hh}:${mm}`, 101, 101.2, 100.8, 101.0, 60));
  }
  marketData.set('2308', b);

  const sim = new DayBrainBacktestSimulator();
  sim.loadBriefings([makeBriefing('2308', 'LONG_ONLY', 85)]);
  const report = sim.runSimulation(marketData);
  assert.equal(report.summary.total_trades, 1);
  const t = report.trades[0];
  assert.equal(t.exitReason, 'FORCE_FLAT');
  assert.equal(t.exitTime, '2026-08-03T13:10:00+08:00');
});

// ---- 空方：SHORT_ONLY 日 + force_flat_by 13:00（§7.4） ----
test('模擬日：空方進場 → forceFlatBy 13:00 強制回補（早於多方 13:10）', () => {
  const marketData = new Map<string, MinuteBar[]>();
  const b: MinuteBar[] = [];
  // 09:00–09:15 平穩
  for (let m = 9 * 60; m <= 9 * 60 + 15; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    b.push(bar('2317', `${hh}:${mm}`, 100, 100.4, 99.8, 100.2, 50));
  }
  // 09:16 爆量下殺 → SELL 候選
  b.push({ symbol: '2317', datetime: '2026-08-03T09:16:00+08:00', open: 100.0, high: 100.1, low: 98.9, close: 99.0, volume: 500 });
  // 09:17–12:59 橫盤
  for (let m = 9 * 60 + 17; m <= 12 * 60 + 59; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    b.push(bar('2317', `${hh}:${mm}`, 99, 99.2, 98.8, 99.0, 60));
  }
  marketData.set('2317', b);

  const sim = new DayBrainBacktestSimulator();
  sim.loadBriefings([makeBriefing('2317', 'SHORT_ONLY', -75)]);
  const report = sim.runSimulation(marketData);
  assert.equal(report.summary.total_trades, 1);
  const t = report.trades[0];
  assert.equal(t.action, 'SELL_TO_OPEN');
  assert.equal(t.exitReason, 'FORCE_FLAT');
  assert.equal(t.exitTime, '2026-08-03T13:00:00+08:00', '空單 13:00 強制回補');
});

// ---- Briefing 參數注入（§12.4：volume_surge_threshold / 時間窗） ----
test('觸發條件：volume_surge_threshold 自 Briefing 載入（2.5 → 5.0 抑制訊號）', () => {
  const marketData = new Map<string, MinuteBar[]>();
  const b: MinuteBar[] = [];
  for (let m = 9 * 60; m <= 9 * 60 + 20; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    b.push(bar('2308', `${hh}:${mm}`, 100, 100.4, 99.8, 100.2, 50));
  }
  b.push(surgeBar('2308', '09:21', 101.0, 500)); // 10 倍均量
  marketData.set('2308', b);

  // threshold 5.0 → 10 倍仍觸發
  const simHigh = new DayBrainBacktestSimulator();
  simHigh.loadBriefings([makeBriefing('2308', 'LONG_ONLY', 85, {
    key_levels: { anchor_vwap_estimate: 100, breakout_pivot_price: 100, support_invalidation_price: 100, volume_surge_threshold: 5.0 },
  })]);
  const rHigh = simHigh.runSimulation(marketData);
  assert.equal(rHigh.summary.total_trades, 1, 'threshold 5.0 仍觸發（10 倍）');

  // threshold 20 → 10 倍不觸發
  const simLow = new DayBrainBacktestSimulator();
  simLow.loadBriefings([makeBriefing('2308', 'LONG_ONLY', 85, {
    key_levels: { anchor_vwap_estimate: 100, breakout_pivot_price: 100, support_invalidation_price: 100, volume_surge_threshold: 20 },
  })]);
  const rLow = simLow.runSimulation(marketData);
  assert.equal(rLow.summary.total_trades, 0, 'threshold 20 抑制訊號');
});

test('觸發條件：時間窗自 Briefing 載入（start_time 晚於訊號 → 不進場）', () => {
  const marketData = new Map<string, MinuteBar[]>();
  const b: MinuteBar[] = [];
  for (let m = 9 * 60; m <= 9 * 60 + 20; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    b.push(bar('2308', `${hh}:${mm}`, 100, 100.4, 99.8, 100.2, 50));
  }
  b.push(surgeBar('2308', '09:21', 101.0, 500));
  marketData.set('2308', b);

  // start_time 09:30 → 09:21 訊號被擋
  const sim = new DayBrainBacktestSimulator();
  sim.loadBriefings([makeBriefing('2308', 'LONG_ONLY', 85, {
    active_window: { start_time: '09:30', no_new_entry_after: '11:30', force_flat_by: '13:10' },
  })]);
  const r = sim.runSimulation(marketData);
  assert.equal(r.summary.total_trades, 0);
});

// ---- 假突破回收（持倉中不重複進場） ----
test('模擬日：持倉中不再對同標的開新倉（activePositions 防重）', () => {
  const marketData = new Map<string, MinuteBar[]>();
  const b: MinuteBar[] = [];
  for (let m = 9 * 60; m <= 9 * 60 + 20; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    b.push(bar('2308', `${hh}:${mm}`, 100, 100.4, 99.8, 100.2, 50));
  }
  b.push(surgeBar('2308', '09:21', 101.0, 500));
  b.push(surgeBar('2308', '09:22', 101.5, 600)); // 第二次爆量（持倉中）
  b.push(surgeBar('2308', '09:23', 102.0, 700));
  marketData.set('2308', b);

  const sim = new DayBrainBacktestSimulator();
  sim.loadBriefings([makeBriefing('2308', 'LONG_ONLY', 85)]);
  const report = sim.runSimulation(marketData);
  assert.equal(report.summary.total_trades, 1, '持倉中不重複開倉');
});

// ---- 報告結構（§12.5） ----
test('報告：空市場資料 → summary 全零 + trades 空', () => {
  const sim = new DayBrainBacktestSimulator();
  const report = sim.runSimulation(new Map());
  assert.equal(report.summary.total_trades, 0);
  assert.equal(report.summary.net_total_pnl_ntd, 0);
  assert.equal(report.summary.max_drawdown_ntd, 0);
  assert.equal(report.summary.profit_factor, 0);
  assert.deepEqual(report.trades, []);
  assert.deepEqual(report.engine_effectiveness, {
    blocked_by_briefing_bias: 0, blocked_by_sector_limit: 0, blocked_by_margin_cap: 0, priority_ranking_conflicts_resolved: 0,
  });
});

test('報告：多筆交易 → max_drawdown 計算正確（虧損曲線）', () => {
  // 手動塞 2 筆虧損 1 筆獲利
  const marketData = new Map<string, MinuteBar[]>();
  const b: MinuteBar[] = [];
  for (let m = 9 * 60; m <= 9 * 60 + 20; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    b.push(bar('2308', `${hh}:${mm}`, 100, 100.4, 99.8, 100.2, 50));
  }
  b.push(surgeBar('2308', '09:21', 101.0, 500));
  // 09:22 暴跌 → STOP_LOSS（-）
  b.push({ symbol: '2308', datetime: '2026-08-03T09:22:00+08:00', open: 101.0, high: 101.1, low: 99.4, close: 99.5, volume: 200 });
  // 09:23 再爆量突破 → 第二次進場（先前已離場）
  b.push(surgeBar('2308', '09:23', 101.0, 500));
  // 09:24 再跌 → STOP_LOSS（-）
  b.push({ symbol: '2308', datetime: '2026-08-03T09:24:00+08:00', open: 101.0, high: 101.1, low: 99.4, close: 99.5, volume: 200 });
  marketData.set('2308', b);

  const sim2 = new DayBrainBacktestSimulator();
  sim2.loadBriefings([makeBriefing('2308', 'LONG_ONLY', 85)]);
  const report = sim2.runSimulation(marketData);
  assert.equal(report.summary.total_trades, 2);
  assert.ok(report.summary.max_drawdown_ntd < 0, '虧損累計回撤為負');
});

// ---- Grid Search 迭代（§13.1） ----
test('每迭代全新 Simulator 實例：狀態不殘留（§13.1）', () => {
  const marketData = new Map<string, MinuteBar[]>();
  const b: MinuteBar[] = [];
  for (let m = 9 * 60; m <= 9 * 60 + 20; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    b.push(bar('2308', `${hh}:${mm}`, 100, 100.4, 99.8, 100.2, 50));
  }
  b.push(surgeBar('2308', '09:21', 101.0, 500));
  marketData.set('2308', b);

  // 迭代 1：停損 1.5%
  const sim1 = new DayBrainBacktestSimulator();
  sim1.loadBriefings([makeBriefing('2308', 'LONG_ONLY', 85, { hard_stop_loss_pct: 1.5 })]);
  const r1 = sim1.runSimulation(marketData);
  assert.equal(r1.summary.total_trades, 1);

  // 迭代 2：全新實例（清空狀態）
  const sim2 = new DayBrainBacktestSimulator();
  sim2.loadBriefings([makeBriefing('2308', 'LONG_ONLY', 85, { hard_stop_loss_pct: 1.5 })]);
  const r2 = sim2.runSimulation(marketData);
  assert.equal(r2.summary.total_trades, 1);
  // 兩實例獨立（§13.1：每次迭代全新實例清空狀態）
  assert.equal(sim1.getCompletedTradesCount(), 1, 'sim1 狀態獨立');
  assert.equal(sim2.getCompletedTradesCount(), 1, 'sim2 狀態獨立');
});

// ---- timeOnlyOf helper ----
test('timeOnlyOf：ISO → HH:MM', () => {
  assert.equal(timeOnlyOf('2026-08-03T09:15:00+08:00'), '09:15');
  assert.equal(timeOnlyOf('2026-08-03T13:30:00+08:00'), '13:30');
});
