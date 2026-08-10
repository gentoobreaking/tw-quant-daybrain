// T003 Freshness Gate 單元測試
// 驗證：§3.1 判定規則、§3.2 降級狀態機、時間邊界（29s/31s）、快取規則組合、未知 source

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreshnessGate, MARKET_LAYER_TOOLS } from './freshness_gate.js';
import type { Envelope } from '../mcp/envelope.js';

const NOW = new Date('2026-08-10T09:30:00+08:00');

function mkEnvelope(partial: Partial<Envelope['_lineage']> = {}, data: unknown = { price: 100 }): Envelope {
  return {
    data,
    _lineage: {
      source: 'TWSE',
      freshness: 'REALTIME_INTRADAY',
      fetched_at: NOW.toISOString(),
      is_cached: false,
      ...partial,
    },
  };
}

function mkGate(opts: Parameters<typeof FreshnessGate.prototype.check>[0] extends never ? never : object = {}) {
  return new FreshnessGate({
    stalenessMaxSec: 30,
    cacheSamplingSecMax: 10,
    cacheTtlSecMax: 4,
    lockoutFailureThreshold: 3,
    nowFn: () => NOW,
    ...opts,
  });
}

// ===== §3.1 盤中訊號 =====

test('盤中：REALTIME_INTRADAY + fetched_at 距今 ≤ 30s → pass', () => {
  const gate = mkGate();
  const env = mkEnvelope({ fetched_at: new Date(NOW.getTime() - 29_000).toISOString() });
  const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, true);
  assert.equal(r.state, 'NORMAL');
  assert.equal(r.lagSec, 29);
});

test('盤中：時間邊界 31s → fail（stale_data）→ STALE', () => {
  const gate = mkGate();
  const env = mkEnvelope({ fetched_at: new Date(NOW.getTime() - 31_000).toISOString() });
  const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, false);
  assert.equal(r.cause, 'stale_data');
  assert.equal(r.state, 'STALE');
  assert.ok(gate.isSymbolStale('2308'));
});

test('盤中：邊界 30s 整 → pass（≤ 容許）', () => {
  const gate = mkGate();
  const env = mkEnvelope({ fetched_at: new Date(NOW.getTime() - 30_000).toISOString() });
  const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, true);
});

test('盤中：freshness 非 REALTIME_INTRADAY → fail（freshness_mismatch）', () => {
  const gate = mkGate();
  const env = mkEnvelope({ freshness: 'HISTORICAL', data_date: '2026-08-10' });
  const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, false);
  assert.equal(r.cause, 'freshness_mismatch');
});

// ===== 快取容許規則 =====

test('快取容許：sampling_sec ≤ 10 且 cache_ttl ≤ 4 → pass', () => {
  const gate = mkGate();
  const env = mkEnvelope({ is_cached: true, sampling_sec: 10, cache_ttl: 4 });
  const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, true);
});

test('快取容許：sampling_sec = 11 → fail（cache_rule_violation）', () => {
  const gate = mkGate();
  const env = mkEnvelope({ is_cached: true, sampling_sec: 11, cache_ttl: 4 });
  const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, false);
  assert.equal(r.cause, 'cache_rule_violation');
});

test('快取容許：cache_ttl = 5 → fail（cache_rule_violation）', () => {
  const gate = mkGate();
  const env = mkEnvelope({ is_cached: true, sampling_sec: 10, cache_ttl: 5 });
  const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, false);
});

test('快取組合：sampling_sec 缺 + ttl 缺 → fail', () => {
  const gate = mkGate();
  const env = mkEnvelope({ is_cached: true });
  const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, false);
});

// ===== §3.1 盤前 =====

test('盤前：POST_MARKET_TODAY → pass', () => {
  const gate = mkGate();
  const env = mkEnvelope({ freshness: 'POST_MARKET_TODAY' });
  const r = gate.check(env, 'PRE_MARKET', { symbol: '2308' });
  assert.equal(r.passed, true);
});

test('盤前：freshness 非 POST_MARKET_TODAY → fail', () => {
  const gate = mkGate();
  const env = mkEnvelope({ freshness: 'REALTIME_INTRADAY' });
  const r = gate.check(env, 'PRE_MARKET', { symbol: '2308' });
  assert.equal(r.passed, false);
  assert.equal(r.cause, 'freshness_mismatch');
});

// ===== §3.1 歷史回溯 =====

test('歷史：HISTORICAL + data_date 覆蓋 → pass', () => {
  const gate = mkGate();
  const env = mkEnvelope({ freshness: 'HISTORICAL', data_date: '2026-08-10' });
  const r = gate.check(env, 'HISTORICAL', {
    queryRange: { start: '2026-08-01', end: '2026-08-10' },
  });
  assert.equal(r.passed, true);
});

test('歷史：data_date 超出查詢範圍 → fail', () => {
  const gate = mkGate();
  const env = mkEnvelope({ freshness: 'HISTORICAL', data_date: '2026-07-01' });
  const r = gate.check(env, 'HISTORICAL', {
    queryRange: { start: '2026-08-01', end: '2026-08-10' },
  });
  assert.equal(r.passed, false);
  assert.equal(r.cause, 'data_date_out_of_range');
});

test('歷史：缺 data_date → fail（missing_data_date）', () => {
  const gate = mkGate();
  const env = mkEnvelope({ freshness: 'HISTORICAL' });
  const r = gate.check(env, 'HISTORICAL', {});
  assert.equal(r.passed, false);
  assert.equal(r.cause, 'missing_data_date');
});

// ===== 附錄 A：未知 source =====

test('未知 _lineage.source → fail（unknown_source）', () => {
  const gate = mkGate();
  const env = mkEnvelope({ source: 'UNKNOWN_SOURCE' });
  const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, false);
  assert.equal(r.cause, 'unknown_source');
});

test('官方 source（TWSE/TPEx/MOPS/TAIFEX/MIS）→ 正常判定', () => {
  for (const source of ['TWSE', 'TPEx', 'MOPS', 'TAIFEX', 'MIS']) {
    const gate = mkGate();
    const env = mkEnvelope({ source });
    const r = gate.check(env, 'INTRADAY_SIGNAL', { symbol: '2308' });
    assert.equal(r.passed, true, `source=${source} 應 pass`);
  }
});

// ===== §3.2 降級狀態機 =====

test('STALE：單標的逾時 → 該標的停訊，其他標的仍可 pass', () => {
  const gate = mkGate();
  // 2308 逾時
  const staleEnv = mkEnvelope({ fetched_at: new Date(NOW.getTime() - 60_000).toISOString() });
  const r1 = gate.check(staleEnv, 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r1.state, 'STALE');
  assert.ok(gate.isSymbolStale('2308'));
  // 2330 正常
  const freshEnv = mkEnvelope();
  const r2 = gate.check(freshEnv, 'INTRADAY_SIGNAL', { symbol: '2330' });
  assert.equal(r2.passed, true);
  assert.equal(r2.state, 'STALE'); // 仍為 STALE（有標的停訊中）
  assert.ok(!gate.isSymbolStale('2330'));
});

test('STALE → 標的恢復：recoverSymbol 後可正常 pass', () => {
  const gate = mkGate();
  const staleEnv = mkEnvelope({ fetched_at: new Date(NOW.getTime() - 60_000).toISOString() });
  gate.check(staleEnv, 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.ok(gate.isSymbolStale('2308'));
  gate.recoverSymbol('2308');
  assert.ok(!gate.isSymbolStale('2308'));
  const r = gate.check(mkEnvelope(), 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, true);
});

test('DEGRADED：市場層資料逾時 → DEGRADED（停發新訊僅管持倉）', () => {
  const gate = mkGate();
  const staleEnv = mkEnvelope({ fetched_at: new Date(NOW.getTime() - 120_000).toISOString() });
  const r = gate.check(staleEnv, 'INTRADAY_MARKET', {});
  assert.equal(r.passed, false);
  assert.equal(r.state, 'DEGRADED');
  // DEGRADED 下標的訊號判定仍執行，但狀態保持 DEGRADED
  const r2 = gate.check(mkEnvelope(), 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r2.passed, true);
  assert.equal(r2.state, 'DEGRADED');
});

test('DEGRADED → 市場層恢復 → NORMAL', () => {
  const gate = mkGate();
  gate.check(mkEnvelope({ fetched_at: new Date(NOW.getTime() - 120_000).toISOString() }), 'INTRADAY_MARKET', {});
  assert.equal(gate.getState(), 'DEGRADED');
  const r = gate.check(mkEnvelope(), 'INTRADAY_MARKET', {});
  assert.equal(r.passed, true);
  assert.equal(gate.getState(), 'NORMAL');
});

test('LOCKOUT：連續 3 次守門失敗 → LOCKOUT（全系統停訊）', () => {
  const gate = mkGate();
  const staleEnv = mkEnvelope({ fetched_at: new Date(NOW.getTime() - 120_000).toISOString() });
  gate.check(staleEnv, 'INTRADAY_SIGNAL', { symbol: '2308' });
  gate.check(staleEnv, 'INTRADAY_SIGNAL', { symbol: '2317' });
  assert.equal(gate.getState(), 'STALE');
  const r3 = gate.check(staleEnv, 'INTRADAY_SIGNAL', { symbol: '2327' });
  assert.equal(r3.state, 'LOCKOUT');
  assert.equal(r3.cause, 'lockout_after_3_failures');
  // LOCKOUT 後即使資料新鮮也拒絕
  const r4 = gate.check(mkEnvelope(), 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r4.passed, false);
  assert.equal(r4.cause, 'lockout_active');
});

test('LOCKOUT：forceLockout（MCP 連線中斷）→ 全系統停訊', () => {
  const gate = mkGate();
  gate.forceLockout('mcp_disconnected');
  assert.equal(gate.getState(), 'LOCKOUT');
  const r = gate.check(mkEnvelope(), 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, false);
  assert.equal(r.cause, 'lockout_active');
});

test('LOCKOUT → recoverFromLockout（重連成功）→ NORMAL', () => {
  const gate = mkGate();
  gate.forceLockout('mcp_disconnected');
  assert.equal(gate.getState(), 'LOCKOUT');
  gate.recoverFromLockout();
  assert.equal(gate.getState(), 'NORMAL');
  const r = gate.check(mkEnvelope(), 'INTRADAY_SIGNAL', { symbol: '2308' });
  assert.equal(r.passed, true);
});

// ===== 事件日誌 =====

test('守門事件：pass/fail 寫入（freshness_gate_pass|fail 含 cause/symbol/lag_sec）', () => {
  const events: Array<Record<string, unknown>> = [];
  const gate = new FreshnessGate({
    nowFn: () => NOW,
    onEvent: (e) => events.push({ ...e }),
  });
  gate.check(mkEnvelope(), 'INTRADAY_SIGNAL', { symbol: '2308' });
  const failEnv = mkEnvelope({ fetched_at: new Date(NOW.getTime() - 60_000).toISOString() });
  gate.check(failEnv, 'INTRADAY_SIGNAL', { symbol: '2317' });

  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'freshness_gate_pass');
  assert.equal(events[0].symbol, '2308');
  assert.equal(events[1].type, 'freshness_gate_fail');
  assert.equal(events[1].cause, 'stale_data');
  assert.equal(events[1].symbol, '2317');
  assert.equal(events[1].lagSec, 60);
});

test('市場層工具清單（§3.2）', () => {
  assert.ok(MARKET_LAYER_TOOLS.has('get_futures_daily_ohlc'));
  assert.ok(MARKET_LAYER_TOOLS.has('get_put_call_ratio'));
  assert.ok(MARKET_LAYER_TOOLS.has('get_market_summary'));
  assert.equal(MARKET_LAYER_TOOLS.size, 3);
});

test('gate 狀態 API 暴露（T016/T017/T018/T009/T008 消費端）', () => {
  const gate = mkGate();
  assert.equal(typeof gate.getState, 'function');
  assert.equal(typeof gate.isSymbolStale, 'function');
  assert.equal(typeof gate.getStaleSymbols, 'function');
  assert.equal(typeof gate.recoverFromLockout, 'function');
});
