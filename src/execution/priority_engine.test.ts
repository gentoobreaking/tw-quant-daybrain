// T020 Priority Ranking Engine 單元測試（§10）
// 覆蓋：Rank 計算（§10.1 公式/§10.4 範例）、Tier 邊界（49/50/59/60/79/80）、族群 40% 上限、
//       白名單攔截、並發兩標的排序、1 張門檻、register/release、事件寫入
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PriorityRankingEngine,
  computeRankScore,
  tierCapitalForScore,
  type SignalCandidate,
} from './priority_engine.js';
import type { TacticalBriefing } from '../briefing/generator.js';

// 測試用 minimal briefing（滿足 evaluateSignal 所需欄位）
function makeBriefing(bias: 'LONG_ONLY' | 'SHORT_ONLY' | 'NEUTRAL_FLEXIBLE' | 'NO_TRADE', score: number): TacticalBriefing {
  const allowed = bias === 'LONG_ONLY' ? ['BUY_TO_OPEN'] : bias === 'SHORT_ONLY' ? ['SELL_TO_OPEN'] : bias === 'NEUTRAL_FLEXIBLE' ? ['BUY_TO_OPEN', 'SELL_TO_OPEN'] : [];
  return {
    bias_assessment: { bias, score, confidence: 'MEDIUM', scoring_breakdown: [] },
    trading_plan: { allowed_actions: allowed, blocked_actions: [], active_window: { start_time: '09:05', no_new_entry_after: '11:30', force_flat_by: '13:10' }, key_levels: { anchor_vwap_estimate: 0, breakout_pivot_price: 0, support_invalidation_price: 0, volume_surge_threshold: 2.5 } },
    risk_guardrails: { max_position_size_shares: 2000, hard_stop_loss_pct: 1.5, take_profit_target_1_pct: 2.0, trailing_stop_activation_pct: 2.0, trailing_stop_callback_pct: 1.0, max_drawdown_limit_ntd: 30000, safety_flags: { is_disposition: false, can_daytrade: true, can_short_first: true, earnings_announcement_today: false } },
    target: { symbol: '2308', name: 'x', market: 'TWSE', yesterday_close: 100 },
    _lineage: { generated_at: '', agent_version: '', mcp_server_version: '', data_sources: [] },
  };
}

function cand(over: Partial<SignalCandidate>): SignalCandidate {
  return { symbol: '2308', action: 'BUY_TO_OPEN', price: 150, volumeSurgeRatio: 3.0, vwapDeviationPct: 0.5, ...over };
}

// ---- Rank Score 計算（§10.1） ----
test('computeRankScore：§10.4 範例（台達電 85 分爆量 3 倍 vs 廣達 60 分爆量 5 倍）', () => {
  const delta = computeRankScore(85, 3.0, 0); // 0.4×85 + 0.5×60 = 64
  assert.equal(delta, 64);
  const quanta = computeRankScore(60, 5.0, 0); // 0.4×60 + 0.5×100 = 74
  assert.equal(quanta, 74);
  assert.ok(quanta > delta, '廣達 Rank 高於台達電 → 優先派單');
});

test('computeRankScore：爆量封頂 100（5 倍）', () => {
  assert.equal(computeRankScore(50, 5.0, 0), 0.4 * 50 + 0.5 * 100); // 70
  assert.equal(computeRankScore(50, 10.0, 0), 0.4 * 50 + 0.5 * 100); // 封頂不變
});

test('computeRankScore：VWAP 偏離扣分', () => {
  const noDev = computeRankScore(80, 3.0, 0);
  const dev = computeRankScore(80, 3.0, 2.0); // -0.1×2×15 = -3
  assert.equal(noDev - dev, 3);
});

test('computeRankScore：權重可調參（§13）', () => {
  const r = computeRankScore(80, 3.0, 1.0, { wBias: 0.5, wSurge: 0.4, wDist: 0.1 });
  assert.equal(r, 0.5 * 80 + 0.4 * 60 - 0.1 * 15);
});

// ---- Tier 資金（§10.2） ----
test('tierCapitalForScore：Tier 邊界 49/50/59/60/79/80', () => {
  const pool = 3_000_000;
  assert.equal(tierCapitalForScore(49, pool), 0); // Tier 4
  assert.equal(tierCapitalForScore(50, pool), pool * 0.10); // Tier 3
  assert.equal(tierCapitalForScore(59, pool), pool * 0.10);
  assert.equal(tierCapitalForScore(60, pool), pool * 0.20); // Tier 2
  assert.equal(tierCapitalForScore(79, pool), pool * 0.20);
  assert.equal(tierCapitalForScore(80, pool), pool * 0.33); // Tier 1
});

// ---- evaluateSignal ----
test('evaluateSignal：白名單攔截（LONG_ONLY 日 SELL_TO_OPEN → 拒絕）', () => {
  const engine = new PriorityRankingEngine();
  const d = engine.evaluateSignal(cand({ action: 'SELL_TO_OPEN' }), makeBriefing('LONG_ONLY', 75), 'ELECTRONICS');
  assert.equal(d.shouldExecute, false);
  assert.match(d.reason, /被 Briefing 阻擋/);
});

test('evaluateSignal：NO_TRADE → 拒絕', () => {
  const engine = new PriorityRankingEngine();
  const d = engine.evaluateSignal(cand({ action: 'BUY_TO_OPEN' }), makeBriefing('NO_TRADE', 0), 'ELECTRONICS');
  assert.equal(d.shouldExecute, false);
});

test('evaluateSignal：Tier 1（85 分）→ 33% 資金 + rankScore', () => {
  const engine = new PriorityRankingEngine({ totalMarginPoolNtd: 3_000_000 });
  const d = engine.evaluateSignal(cand({ volumeSurgeRatio: 3.0, vwapDeviationPct: 0 }), makeBriefing('LONG_ONLY', 85), 'ELECTRONICS');
  assert.equal(d.shouldExecute, true);
  assert.equal(d.allocatedCapitalNtd, 990_000); // 300萬 × 0.33
  assert.equal(d.rankScore, 0.4 * 85 + 0.5 * 60); // 64
});

test('evaluateSignal：Tier 4（45 分）→ 拒絕', () => {
  const engine = new PriorityRankingEngine();
  const d = engine.evaluateSignal(cand({}), makeBriefing('LONG_ONLY', 45), 'ELECTRONICS');
  assert.equal(d.shouldExecute, false);
  assert.match(d.reason, /Tier 4/);
});

test('evaluateSignal：族群 40% 上限（同族群已滿 → 拒絕）', () => {
  const engine = new PriorityRankingEngine({ totalMarginPoolNtd: 3_000_000 });
  // 總曝光 600 萬 × 40% = 240 萬族群上限；註冊 240 萬同族群
  engine.registerPosition('2317', 2_400_000, 'ELECTRONICS');
  const d = engine.evaluateSignal(cand({ symbol: '2308' }), makeBriefing('LONG_ONLY', 85), 'ELECTRONICS');
  assert.equal(d.shouldExecute, false);
  assert.match(d.reason, /同族群/);
});

test('evaluateSignal：不同族群不受影響', () => {
  const engine = new PriorityRankingEngine({ totalMarginPoolNtd: 3_000_000 });
  engine.registerPosition('2317', 2_400_000, 'ELECTRONICS');
  const d = engine.evaluateSignal(cand({ symbol: '2308' }), makeBriefing('LONG_ONLY', 85), 'FINANCE');
  assert.equal(d.shouldExecute, true);
});

test('evaluateSignal：MAX_POSITIONS=2 已滿 → 拒絕新標的', () => {
  const engine = new PriorityRankingEngine({ maxPositions: 2 });
  engine.registerPosition('2317', 100_000, 'A');
  engine.registerPosition('2330', 100_000, 'B');
  const d = engine.evaluateSignal(cand({ symbol: '2308' }), makeBriefing('LONG_ONLY', 85), 'C');
  assert.equal(d.shouldExecute, false);
  assert.match(d.reason, /MAX_POSITIONS/);
});

test('evaluateSignal：資金不足 1 張 → 拒絕', () => {
  const engine = new PriorityRankingEngine({ totalMarginPoolNtd: 3_000_000 });
  // 高價股：價格 2000 → 1 張 = 200 萬；Tier 3（55 分）僅 30 萬 → 不足
  const d = engine.evaluateSignal(cand({ symbol: '2308', price: 2000 }), makeBriefing('LONG_ONLY', 55), 'ELECTRONICS');
  assert.equal(d.shouldExecute, false);
  assert.match(d.reason, /不足以買進 1 張/);
});

test('evaluateSignal：總曝光上限 → 拒絕', () => {
  const engine = new PriorityRankingEngine({ totalMarginPoolNtd: 3_000_000 });
  engine.registerPosition('2317', 6_000_000, 'A'); // 已達總曝光 600 萬
  const d = engine.evaluateSignal(cand({ symbol: '2308' }), makeBriefing('LONG_ONLY', 85), 'B');
  assert.equal(d.shouldExecute, false);
  assert.match(d.reason, /總曝光上限/);
});

test('register/release：資金回收後可再分配', () => {
  const engine = new PriorityRankingEngine({ totalMarginPoolNtd: 3_000_000 });
  engine.registerPosition('2317', 2_400_000, 'ELECTRONICS');
  assert.equal(engine.totalExposure(), 2_400_000);
  engine.releasePosition('2317');
  assert.equal(engine.totalExposure(), 0);
  const d = engine.evaluateSignal(cand({ symbol: '2308' }), makeBriefing('LONG_ONLY', 85), 'ELECTRONICS');
  assert.equal(d.shouldExecute, true);
});

// ---- rank()（T009 PriorityEngine 接口，§10.4 競爭搶單） ----
test('rank：同 tick 兩標的 → 依 Rank Score 排序（廣達優先）', async () => {
  const engine = new PriorityRankingEngine();
  const ranked = await engine.rank([
    { signal_id: 's1', symbol: '2308', score: 85, volumeSurgeRatio: 3.0, vwapDeviationPct: 0 },
    { signal_id: 's2', symbol: '2382', score: 60, volumeSurgeRatio: 5.0, vwapDeviationPct: 0 },
  ]);
  assert.deepEqual(ranked, ['s2', 's1']); // 74 > 64
});

test('rank：事件寫入 priority_ranked（含 rankScore）', async () => {
  const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
  const engine = new PriorityRankingEngine({
    events: { write: (type: string, fields: Record<string, unknown>) => { events.push({ type, fields }); } } as never,
  });
  await engine.rank([{ signal_id: 's1', symbol: '2308', score: 85, volumeSurgeRatio: 3.0 }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'priority_ranked');
  const candidates = events[0].fields.candidates as Array<Record<string, unknown>>;
  assert.equal(candidates[0].signal_id, 's1');
  assert.equal(candidates[0].rankScore, 64);
});

test('evaluateSignal：決策寫入 priority_ranked 事件', () => {
  const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
  const engine = new PriorityRankingEngine({
    events: { write: (type: string, fields: Record<string, unknown>) => { events.push({ type, fields }); } } as never,
  });
  engine.evaluateSignal(cand({}), makeBriefing('LONG_ONLY', 85), 'ELECTRONICS');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'priority_ranked');
  const c = (events[0].fields.candidates as Array<Record<string, unknown>>)[0];
  assert.equal(c.symbol, '2308');
  assert.equal(c.shouldExecute, true);
  assert.equal(c.allocatedCapitalNtd, 990_000);
});
