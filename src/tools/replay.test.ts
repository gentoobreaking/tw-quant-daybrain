// T012 回放工具與滑價驗證 測試
// 驗收：時間軸排序、決策追溯（輸入展開）、純讀離線、滑價 >0.3% 標註、
//      缺欄位警示不靜默填補、JSON/人類可讀輸出

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLogger } from '../logging/event_logger.js';
import type { DayBrainEvent } from '../logging/event_types.js';
import {
  replayDay,
  toJson,
  toSummaryText,
  ABNORMAL_SLIPPAGE_PCT,
  replayCli,
} from './replay.js';

/** 寫入一組測試日誌並回放 */
function setupLogger(events: DayBrainEvent[]): { logger: EventLogger; date: string } {
  const dir = mkdtempSync(join(tmpdir(), 't012-'));
  const logger = new EventLogger(dir);
  const date = '2026-08-10';
  for (const e of events) logger.write(e.type, e, new Date(e.ts));
  return { logger, date };
}

test('回放：時間軸依 ts+seq 排序 + 決策追溯展開輸入', () => {
  const events: DayBrainEvent[] = [
    {
      ts: '2026-08-10T09:35:00+08:00',
      type: 'signal_issued',
      signal_id: 's1',
      symbol: '2308',
      score: 82,
      grade: 'STRONG_BUY',
      inputs: { vwap: 96.5, volume_surge_ratio: 2.8, price: 97.2 },
      score_breakdown: { level: 25, volume: 25, breakout: 25, market: 7 },
    },
    {
      ts: '2026-08-10T09:30:00+08:00',
      type: 'freshness_gate_pass',
      signal_id: 's1',
    },
    {
      ts: '2026-08-10T09:36:00+08:00',
      type: 'signal_triggered',
      signal_id: 's1',
    },
    {
      ts: '2026-08-10T09:31:00+08:00',
      type: 'priority_ranked',
      candidates: [{ signal_id: 's1', rank: 1 }],
    },
    {
      ts: '2026-08-10T09:32:00+08:00',
      type: 'bias_locked',
      bias: 'LONG',
      score: 62,
    },
  ] as unknown as DayBrainEvent[];

  const { logger, date } = setupLogger(events);
  const r = replayDay(logger, date);

  // 時間軸排序（最早在前）
  assert.equal(r.timeline[0].type, 'freshness_gate_pass'); // 09:30
  assert.equal(r.timeline[1].type, 'priority_ranked'); // 09:31
  assert.equal(r.timeline[2].type, 'bias_locked'); // 09:32
  assert.equal(r.timeline[3].type, 'signal_issued'); // 09:35
  assert.equal(r.timeline[4].type, 'signal_triggered'); // 09:36

  // 訊號追溯展開
  assert.equal(r.signals.length, 1);
  const s = r.signals[0];
  assert.equal(s.signal_id, 's1');
  assert.equal(s.score, 82);
  assert.equal(s.grade, 'STRONG_BUY');
  assert.deepEqual(s.inputs, { vwap: 96.5, volume_surge_ratio: 2.8, price: 97.2 });
  assert.deepEqual(s.breakdown, { level: 25, volume: 25, breakout: 25, market: 7 });
  assert.deepEqual(s.gate, { passed: true });
  assert.equal(s.priority_rank, 1);
});

test('回放：守門失敗 + Bias 攔截 + 滑價異常標註（>0.3%）', () => {
  const events: DayBrainEvent[] = [
    {
      ts: '2026-08-10T09:35:00+08:00',
      type: 'signal_issued',
      signal_id: 's2',
      symbol: '2317',
      score: 88,
      blocked_by_briefing_bias: true,
      suggested_price: 100,
      actual_price: 101.5, // +1.5% 異常
    },
    {
      ts: '2026-08-10T09:36:00+08:00',
      type: 'freshness_gate_fail',
      signal_id: 's2',
      cause: 'STALE_SOURCE',
    },
  ] as unknown as DayBrainEvent[];

  const { logger, date } = setupLogger(events);
  const r = replayDay(logger, date);

  const s = r.signals[0];
  assert.equal(s.blocked_by_briefing_bias, true);
  assert.deepEqual(s.gate, { passed: false, cause: 'STALE_SOURCE' });

  assert.equal(r.slippage.length, 1);
  const sc = r.slippage[0];
  assert.equal(sc.slippage_pct, 1.5);
  assert.equal(sc.abnormal, true);
  assert.ok(Math.abs(sc.slippage_pct!) > ABNORMAL_SLIPPAGE_PCT);
});

test('滑價正常（≤0.3%）不標註異常', () => {
  const events: DayBrainEvent[] = [
    {
      ts: '2026-08-10T09:35:00+08:00',
      type: 'signal_issued',
      signal_id: 's3',
      symbol: '2330',
      score: 85,
      suggested_price: 500,
      actual_price: 501, // +0.2%
    },
  ] as unknown as DayBrainEvent[];
  const { logger, date } = setupLogger(events);
  const r = replayDay(logger, date);
  assert.equal(r.slippage[0].abnormal, false);
  assert.equal(r.slippage[0].slippage_pct, 0.2);
});

test('缺欄位警示：損壞/手寫日誌缺 signal_id、缺滑價資料 → warnings 不靜默填補', () => {
  const dir = mkdtempSync(join(tmpdir(), 't012-warn-'));
  const logger = new EventLogger(dir);
  const date = '2026-08-10';
  // 直接寫入原始行（模擬手動編輯/損壞日誌，繞過 schema 驗證）
  appendFileSync(
    logger.fileForDate(date),
    JSON.stringify({ ts: '2026-08-10T09:35:00+08:00', type: 'signal_issued', symbol: '2308', score: 80 }) +
      '\n' +
      JSON.stringify({ ts: '2026-08-10T09:36:00+08:00', type: 'signal_issued', signal_id: 's4', symbol: '2317', score: 75 }) +
      '\n',
    'utf-8',
  );
  const r = replayDay(logger, date);
  // 缺 signal_id 者被警示且不列入 signals
  assert.equal(r.signals.length, 1);
  assert.ok(r.warnings.some((w) => /缺 signal_id/.test(w)));
  // s4 無 suggested/actual price → 警示
  assert.ok(r.warnings.some((w) => /s4.*缺滑價比對資料/.test(w)));
});

test('輸出：JSON 結構完整 + 人類可讀含時間軸/追溯/滑價', () => {
  const events: DayBrainEvent[] = [
    { ts: '2026-08-10T09:35:00+08:00', type: 'signal_issued', signal_id: 's1', symbol: '2308', score: 80 },
  ] as unknown as DayBrainEvent[];
  const { logger, date } = setupLogger(events);
  const r = replayDay(logger, date);

  const json = JSON.parse(toJson(r));
  assert.equal(json.date, '2026-08-10');
  assert.ok(Array.isArray(json.timeline));
  assert.ok(Array.isArray(json.signals));
  assert.ok(Array.isArray(json.slippage));

  const text = toSummaryText(r);
  assert.match(text, /===== 回放：2026-08-10 =====/);
  assert.match(text, /--- 時間軸 ---/);
  assert.match(text, /--- 訊號追溯 ---/);
  assert.match(text, /--- 滑價驗證/);
});

test('replayCli：無 --date → 回傳 2；無日誌 → 回傳 0 且警示', () => {
  assert.equal(replayCli([]), 2);
  assert.equal(replayCli(['--date', 'bad-date']), 2);

  const dir = mkdtempSync(join(tmpdir(), 't012-cli-'));
  const prev = process.env.LOG_DIR;
  process.env.LOG_DIR = dir;
  try {
    // 該目錄無日誌 → 回放空結果（0 exit）
    assert.equal(replayCli(['--date', '2026-08-10']), 0);
  } finally {
    if (prev === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = prev;
  }
});

test('回放：failed_breakout / position 事件在時間軸呈現', () => {
  const events: DayBrainEvent[] = [
    { ts: '2026-08-10T09:40:00+08:00', type: 'signal_issued', signal_id: 's5', symbol: '2308', score: 81 },
    { ts: '2026-08-10T09:45:00+08:00', type: 'position_opened', position_id: 'P1', symbol: '2308', action: 'BUY_TO_OPEN', entry_price: 96.5 },
    { ts: '2026-08-10T09:50:00+08:00', type: 'failed_breakout', signal_id: 's5', symbol: '2308' },
    { ts: '2026-08-10T09:55:00+08:00', type: 'position_closed', position_id: 'P1', reason: 'FAILED_BREAKOUT' },
  ] as unknown as DayBrainEvent[];
  const { logger, date } = setupLogger(events);
  const r = replayDay(logger, date);
  const types = r.timeline.map((t) => t.type);
  assert.ok(types.includes('position_opened'));
  assert.ok(types.includes('failed_breakout'));
  assert.ok(types.includes('position_closed'));
});
