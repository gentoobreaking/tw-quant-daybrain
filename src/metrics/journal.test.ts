// T010 交易日誌與績效指標 測試
// 驗收：JournalEntry 全欄位、事件計算（不經 LLM）、滑價、週滾動與停用閾值、
//      指標定義表全數、合成事件序列（含無交易日、單筆大虧損邊界）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLogger } from '../logging/event_logger.js';
import type { DayBrainEvent } from '../logging/event_types.js';
import {
  computeJournalEntry,
  computeWeeklyStats,
  computeSlippage,
  pairTrades,
  tradingCost,
  pauseAlertEvents,
  DEFAULT_COST_MODEL,
  type JournalEntry,
} from './journal.js';

/** 合成事件（ts 依序、seq 由 logger 給定；直接構造供純計算測試） */
function ev(type: DayBrainEvent['type'], over: Partial<DayBrainEvent> = {}): DayBrainEvent {
  return {
    ts: over.ts ?? '2026-08-10T10:00:00+08:00',
    type,
    version: 1,
    seq: 0,
    ...over,
  } as DayBrainEvent;
}

/** 一筆完整交易（opened + closed + pnl） */
function trade(
  positionId: string,
  symbol: string,
  pnl: number,
  reason = 'TAKE_PROFIT',
): DayBrainEvent[] {
  return [
    ev('position_opened', {
      ts: '2026-08-10T09:45:00+08:00',
      position_id: positionId,
      symbol,
      signal_id: `sig-${positionId}`,
    }),
    ev('position_closed', {
      ts: '2026-08-10T10:15:00+08:00',
      position_id: positionId,
      reason,
      pnlNtd: pnl,
    }),
  ];
}

// ===== 基本統計（§14.4 summary） =====

test('JournalEntry：全欄位由事件計算（2 勝 1 負範例）', () => {
  const events: DayBrainEvent[] = [
    ev('signal_issued', { ts: '2026-08-10T09:30:00+08:00', signal_id: 's1', symbol: '2308', score: 80 }),
    ev('signal_issued', { ts: '2026-08-10T09:35:00+08:00', signal_id: 's2', symbol: '2317', score: 75 }),
    ev('signal_issued', { ts: '2026-08-10T09:40:00+08:00', signal_id: 's3', symbol: '2330', score: 90 }),
    ev('signal_triggered', { ts: '2026-08-10T09:41:00+08:00', signal_id: 's1' }),
    ev('signal_triggered', { ts: '2026-08-10T09:42:00+08:00', signal_id: 's2' }),
    ...trade('P1', '2308', 23_600),
    ...trade('P2', '2317', 12_000),
    ...trade('P3', '2330', -12_550, 'STOP_LOSS'),
  ];
  const j = computeJournalEntry('2026-08-10', '2.1.0', events);

  assert.equal(j.date, '2026-08-10');
  assert.equal(j.scoring_version, '2.1.0');
  assert.equal(j.summary.signals_issued, 3);
  assert.equal(j.summary.signals_triggered, 2);
  assert.equal(j.summary.trades_executed, 3);
  assert.equal(j.summary.wins, 2);
  assert.equal(j.summary.losses, 1);
  assert.equal(j.summary.gross_pnl, 23_050); // 23600 + 12000 - 12550
  assert.equal(j.summary.hit_rate, 0.67); // 2/3
  assert.equal(j.summary.avg_win, 17_800); // (23600+12000)/2
  assert.equal(j.summary.avg_loss, -12_550);
  assert.equal(j.summary.profit_factor, 2.84); // 35600/12550
  assert.equal(j.summary.signal_conversion_rate, 0.67); // 2/3
  assert.equal(j.summary.expectancy, Math.round(j.summary.net_pnl / 3));
  assert.equal(j.llm_report, null);
  // events 保留必要欄位
  assert.equal(j.events.length, events.length);
});

test('無交易日：全數為 0 / 0 邊界不 NaN', () => {
  const j = computeJournalEntry('2026-08-11', '2.1.0', []);
  assert.equal(j.summary.signals_issued, 0);
  assert.equal(j.summary.trades_executed, 0);
  assert.equal(j.summary.hit_rate, 0);
  assert.equal(j.summary.profit_factor, 0);
  assert.equal(j.summary.max_drawdown_pct, 0);
  assert.equal(j.summary.failed_breakout_rate, 0);
  assert.equal(Number.isNaN(j.summary.expectancy), false);
});

test('單筆大虧損邊界：max_drawdown_pct 正確反映', () => {
  const events: DayBrainEvent[] = [
    ...trade('P1', '2308', 10_000),
    ...trade('P2', '2317', -80_000, 'STOP_LOSS'),
  ];
  const j = computeJournalEntry('2026-08-10', '2.1.0', events);
  // 累積：+10000 → peak 10000 → -70000 → dd = (10000-(-70000))/10000 = 8.0
  assert.equal(j.summary.max_drawdown_pct, 800);
  assert.equal(j.summary.losses, 1);
  assert.equal(j.summary.profit_factor, 0.13);
});

// ===== 交易成本（§12.4） =====

test('tradingCost：手續費 0.1425%×0.28 折 + 當沖證交稅 0.0015', () => {
  // 100 萬名目：手續費 1000000*0.001425*0.28=399 單邊；雙邊 798；稅 1500 → 2298
  const cost = tradingCost(1_000_000, DEFAULT_COST_MODEL);
  assert.ok(cost > 798 && cost < 2300);
  // 小額保底手續費 20 元
  const small = tradingCost(1_000, DEFAULT_COST_MODEL);
  assert.equal(small, 20 * 2 + 1.5); // 40 + 稅 1.5
});

// ===== 配對（§14.4 events） =====

test('pairTrades：opened↔closed 配對，無配對不靜默填補', () => {
  const events: DayBrainEvent[] = [
    ev('position_opened', { position_id: 'P1', symbol: '2308', signal_id: 's1' }),
    ev('position_closed', { position_id: 'P1', reason: 'TAKE_PROFIT', pnlNtd: 500 }),
    ev('position_closed', { position_id: 'P-X', reason: 'FORCE_FLAT' }), // 無配對 → 跳過
  ];
  const trades = pairTrades(events);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].position_id, 'P1');
  assert.equal(trades[0].symbol, '2308');
  assert.equal(trades[0].pnl, 500);
});

// ===== 滑價（§15） =====

test('computeSlippage：建議價 vs 實際成交價', () => {
  const s = computeSlippage([
    { signal_id: 's1', suggested_price: 100, actual_price: 100.2 }, // +0.2%
    { signal_id: 's2', suggested_price: 200, actual_price: 199.4 }, // -0.3%
  ]);
  assert.equal(s, -0.05); // (0.2 + (-0.3))/2
  assert.equal(computeSlippage([]), 0);
});

// ===== 假突破率（v2.0） =====

test('假突破率：failed_breakout ÷ 確認訊號數', () => {
  const events: DayBrainEvent[] = [
    ev('signal_triggered', { signal_id: 's1' }),
    ev('signal_triggered', { signal_id: 's2' }),
    ev('failed_breakout', { signal_id: 's1', symbol: '2308' }),
  ];
  const j = computeJournalEntry('2026-08-10', '2.1.0', events);
  assert.equal(j.summary.failed_breakout_rate, 0.5); // 1/2
});

// ===== 引擎攔截統計（v2.0） =====

test('引擎攔截統計：blocked_by_briefing_bias 等事件欄位', () => {
  const events: DayBrainEvent[] = [
    ev('signal_issued', { signal_id: 's1', symbol: '2308', score: 80, blocked_by_briefing_bias: true }),
    ev('priority_ranked', { candidates: ['s1'], conflicts_resolved: true }),
  ];
  const j = computeJournalEntry('2026-08-10', '2.1.0', events);
  assert.equal(j.summary.blocked.blocked_by_briefing_bias, 1);
  assert.equal(j.summary.blocked.priority_ranking_conflicts_resolved, 1);
});

// ===== 週滾動統計（§15） =====

function day(date: string, trades: number, wins: number, pnl: number): JournalEntry {
  return {
    date,
    scoring_version: '2.1.0',
    summary: {
      signals_issued: trades,
      signals_triggered: trades,
      trades_executed: trades,
      wins,
      losses: trades - wins,
      gross_pnl: pnl,
      net_pnl: pnl,
      hit_rate: trades > 0 ? wins / trades : 0,
      avg_win: 0,
      avg_loss: 0,
      profit_factor: pnl > 0 ? 1.5 : 0.8,
      max_drawdown_pct: 0,
      slippage_avg_pct: 0,
      signal_conversion_rate: 1,
      failed_breakout_rate: 0,
      expectancy: 0,
      blocked: { blocked_by_briefing_bias: 0, blocked_by_sector_limit: 0, blocked_by_margin_cap: 0, priority_ranking_conflicts_resolved: 0 },
    },
    events: [],
    llm_report: null,
  };
}

test('週滾動：連續 2 週 PF<1.1 → pause_recommended + 警示事件', () => {
  const days = [
    day('2026-08-03', 5, 2, -3_000), // W1 虧損
    day('2026-08-04', 4, 1, -2_000), // W1
    day('2026-08-10', 5, 1, -5_000), // W2 虧損
  ];
  const stats = computeWeeklyStats(days);
  assert.equal(stats.length, 2);
  assert.equal(stats[0].pause_recommended, false); // 第一週不觸發（需連續）
  assert.equal(stats[1].pause_recommended, true); // 連續 2 週
  const alerts = pauseAlertEvents(stats);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].reason, /連續 2 週/);
});

test('週滾動：單週 Hit Rate<35% 但前週正常 → 不觸發暫停', () => {
  const days = [
    day('2026-08-03', 10, 6, 20_000), // W1 好
    day('2026-08-10', 10, 2, 1_000), // W2 HR 20% < 35%
  ];
  const stats = computeWeeklyStats(days);
  assert.equal(stats[1].hit_rate, 0.2); // W2 自身 2/10
  assert.equal(stats[1].pause_recommended, false);
});

// ===== 與 EventLogger 整合（T004） =====

test('整合：EventLogger 寫入 → loadDay → computeJournalEntry', () => {
  const dir = mkdtempSync(join(tmpdir(), 't010-'));
  const logger = new EventLogger(dir);
  logger.write('signal_issued', { ts: '2026-08-10T09:30:00+08:00', signal_id: 's1', symbol: '2308', score: 80 });
  logger.write('signal_triggered', { ts: '2026-08-10T09:31:00+08:00', signal_id: 's1' });
  logger.write('position_opened', { ts: '2026-08-10T09:32:00+08:00', position_id: 'P1', symbol: '2308', signal_id: 's1' });
  logger.write('position_closed', { ts: '2026-08-10T09:50:00+08:00', position_id: 'P1', reason: 'TAKE_PROFIT', pnlNtd: 3_000 });

  const events = logger.loadDay('2026-08-10', { silent: true });
  const j = computeJournalEntry('2026-08-10', '2.1.0', events);
  assert.equal(j.summary.signals_issued, 1);
  assert.equal(j.summary.trades_executed, 1);
  assert.equal(j.summary.wins, 1);
  assert.equal(j.summary.gross_pnl, 3_000);
  assert.equal(j.summary.net_pnl, Math.round(3_000 - tradingCost(3_000, DEFAULT_COST_MODEL)));
});
