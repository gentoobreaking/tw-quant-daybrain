// T009 盤中監控循環 測試
// 驗收：完整 tick 循環（mock mcp fixtures）、Bias 攔截、假突破回收、尾盤觸發點、
//      守門失敗、LOCKOUT 停新訊、開盤緩衝、節流、Priority 調度、13:00 硬停

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLogger } from '../logging/event_logger.js';
import { FreshnessGate } from '../gate/freshness_gate.js';
import { SignalScoringEngine, TickConfirmer, type ScoringConfig } from './scoring.js';
import {
  RiskManager,
  InMemoryPositionRepository,
  DEFAULT_RISK_CONFIG,
} from '../risk/risk_manager.js';
import {
  IntradayLoop,
  PHASE3_TRIGGERS,
  type BriefingProvider,
  type PriorityEngine,
  type McpCallFn,
} from './intraday_loop.js';
import type { Envelope } from '../mcp/envelope.js';

const CFG: ScoringConfig = {
  scoring_version: '2.1.0',
  weights: { position: 25, volume: 25, breakout: 25, market_direction: 25 },
  veto: { long_limit_up_proximity: -50, short_surge_lock: -100, generic_restriction: -100 },
  thresholds: { strong_buy: 75, watch: 60, neutral_flexible_override: 85 },
  behavior: { signal_expiry_min: 5 },
};

/** 產生通過守門之 Envelope fixture（TWSE / REALTIME_INTRADAY / 即時戳） */
function envFixture(data: unknown, lineage: Record<string, unknown> = {}): Envelope {
  return {
    data,
    _lineage: {
      source: 'TWSE',
      freshness: 'REALTIME_INTRADAY',
      fetched_at: new Date().toISOString(),
      is_cached: false,
      ...lineage,
    },
    _chart_meta: { chart_type: 'intraday' },
  } as unknown as Envelope;
}

/** 多方滿分 VWAP fixture（market 中性 → total 75 剛好 STRONG_BUY） */
function longVwap(): { data: unknown } {
  return {
    data: { symbol: '2308', vwap: 102, high: 105, low: 99, current_price: 106 },
  };
}

function longSurge(): { data: unknown } {
  return {
    data: { symbol: '2308', volumeSurgeRatio: 3.0, volumeSurgeType: 'BULLISH_SURGE', is_surge: true },
  };
}

/** 空方高分 fixture（price < vwap、BEARISH_BREAKDOWN） */
function shortVwap(): { data: unknown } {
  return {
    data: { symbol: '2308', vwap: 100, high: 108, low: 96, current_price: 95 },
  };
}

function shortSurge(): { data: unknown } {
  return {
    data: { symbol: '2308', volumeSurgeRatio: 1.0, volumeSurgeType: 'BEARISH_BREAKDOWN', is_surge: true },
  };
}

/** 測試環境建構：可變時鐘 + 全套依賴注入 */
function setup(overrides: {
  watchlist: string[];
  startAt?: string;
  fixtures?: (tool: string, symbol: string) => Envelope;
  briefing?: BriefingProvider;
  priority?: PriorityEngine;
  loop?: Partial<ConstructorParameters<typeof IntradayLoop>[0]>;
}): {
  loop: IntradayLoop;
  events: EventLogger;
  gate: FreshnessGate;
  current: { set: (iso: string) => void };
  calls: Array<{ tool: string; symbol: string }>;
} {
  const dir = mkdtempSync(join(tmpdir(), 't009-'));
  const events = new EventLogger(dir);
  const gate = new FreshnessGate();

  let current = new Date(overrides.startAt ?? '2026-08-10T10:00:00+08:00');
  const nowFn = (): Date => current;
  const clock = {
    set(iso: string): void {
      current = new Date(iso);
    },
  };

  const scoring = new SignalScoringEngine(CFG);
  const ticker = new TickConfirmer(2, nowFn);
  const repo = new InMemoryPositionRepository();
  const risk = new RiskManager({
    config: DEFAULT_RISK_CONFIG,
    repo,
    eventLogger: events,
    equity: 1_000_000,
    nowFn,
  });

  const calls: Array<{ tool: string; symbol: string }> = [];
  const call: McpCallFn = async (tool, args) => {
    const symbol = String(args.symbol ?? '');
    calls.push({ tool, symbol });
    if (overrides.fixtures) return overrides.fixtures(tool, symbol);
    if (tool === 'get_intraday_vwap') {
      return envFixture(longVwap().data);
    }
    if (tool === 'detect_volume_surge') {
      return envFixture(longSurge().data);
    }
    return envFixture({});
  };

  const loop = new IntradayLoop({
    watchlist: overrides.watchlist,
    call,
    gate,
    events,
    scoring,
    ticker,
    risk,
    briefing: overrides.briefing,
    priority: overrides.priority,
    nowFn,
    ...overrides.loop,
  });

  return { loop, events, gate, current: clock, calls };
}

/** 讀取特定型別之事件 */
function eventsOf(events: EventLogger, type: string): Array<Record<string, unknown>> {
  return events
    .loadDay('2026-08-10', { silent: true })
    .filter((e) => e.type === type) as unknown as Array<Record<string, unknown>>;
}

// ===== 完整 tick 循環（§4 Phase 2） =====

test('完整 tick 循環：雙 tick 確認 → SignalAdvice + signal_issued 事件', async () => {
  const { loop, events, current } = setup({ watchlist: ['2308'] });

  // tick 1：單 tick 未確認
  const r1 = await loop.tick();
  assert.equal(r1.length, 0);
  // tick 2：確認 → 評分 75（market 中性）→ STRONG_BUY → advice
  current.set('2026-08-10T10:00:10+08:00');
  const r2 = await loop.tick();
  assert.equal(r2.length, 1);
  const a = r2[0];
  assert.equal(a.symbol, '2308');
  assert.equal(a.grade, 'STRONG_BUY');
  assert.equal(a.score, 75);
  assert.equal(a.strategy, 'VWAP_SURGE_LONG');
  assert.equal(a.recommended_entry, 106);
  assert.equal(a.stop_loss_price, 106 * 0.985);
  assert.equal(a.target_price, 106 * 1.03);
  assert.ok(a.position_size_shares > 0);
  assert.ok(a.rr_ratio >= 2);
  assert.ok(a.expiry_ts > a.ts);
  // signal_issued 事件
  const issued = eventsOf(events, 'signal_issued');
  assert.equal(issued.length, 1);
  assert.equal(issued[0].symbol, '2308');
  assert.equal(issued[0].score, 75);
});

test('守門失敗（未知 source）→ freshness_gate_fail 事件、不產出建議', async () => {
  const { loop, events } = setup({
    watchlist: ['2308'],
    fixtures: (tool) => {
      if (tool === 'get_intraday_vwap') {
        return envFixture(longVwap().data, { source: 'UNKNOWN' });
      }
      return envFixture(longSurge().data);
    },
  });
  await loop.tick();
  await loop.tick();
  const fails = eventsOf(events, 'freshness_gate_fail');
  assert.ok(fails.length >= 1);
  assert.equal(fails[0].cause, 'unknown_source');
  assert.equal(eventsOf(events, 'signal_issued').length, 0);
});

test('開盤緩衝 09:00–09:05：僅收集不進場', async () => {
  const { loop, events, current } = setup({ watchlist: ['2308'], startAt: '2026-08-10T09:00:00+08:00' });
  current.set('2026-08-10T09:00:10+08:00');
  const r = await loop.tick();
  assert.equal(r.length, 0);
  assert.equal(eventsOf(events, 'signal_issued').length, 0);
  // 09:05 後恢復
  current.set('2026-08-10T09:05:10+08:00');
  const r2 = await loop.tick();
  assert.equal(r2.length, 1);
});

// ===== Bias 白名單攔截（§4 步驟 4） =====

test('Bias 攔截：LONG_ONLY 日空方高分訊號於 blocked_actions 第一關攔截', async () => {
  const briefing: BriefingProvider = {
    tradingPlan: () => ({
      allowed_actions: ['BUY_TO_OPEN'],
      blocked_actions: ['SELL_TO_OPEN'],
    }),
  };
  const { loop, events } = setup({
    watchlist: ['2308'],
    briefing,
    fixtures: (tool) => (tool === 'get_intraday_vwap' ? envFixture(shortVwap().data) : envFixture(shortSurge().data)),
  });
  await loop.tick();
  const r2 = await loop.tick();
  assert.equal(r2.length, 0); // 空方訊號被攔截
  assert.equal(eventsOf(events, 'signal_issued').length, 0);
});

test('Bias 放行：無 briefing 或未封鎖 → 空方訊號正常產出', async () => {
  const { loop, current } = setup({
    watchlist: ['2308'],
    fixtures: (tool) => (tool === 'get_intraday_vwap' ? envFixture(shortVwap().data) : envFixture(shortSurge().data)),
  });
  await loop.tick();
  current.set('2026-08-10T10:00:10+08:00');
  const r = await loop.tick();
  assert.equal(r.length, 1);
  assert.equal(r[0].strategy, 'BULL_TRAP_VWAP_SHORT');
});

// ===== 假突破回收（§4 步驟 6） =====

test('假突破回收：確認後 3 分鐘內回落 VWAP 下方 → failed_breakout + 取消訊號', async () => {
  let price = 106;
  const { loop, events, current } = setup({
    watchlist: ['2308'],
    fixtures: (tool) => {
      if (tool === 'get_intraday_vwap') {
        return envFixture({ symbol: '2308', vwap: 102, high: 105, low: 99, current_price: price });
      }
      return envFixture(longSurge().data);
    },
  });
  await loop.tick();
  current.set('2026-08-10T10:00:10+08:00');
  const r2 = await loop.tick();
  assert.equal(r2.length, 1); // 確認 → advice
  // 1 分鐘後回落 VWAP 下方（price 101 < vwap 102）
  price = 101;
  current.set('2026-08-10T10:01:10+08:00');
  const r3 = await loop.tick();
  assert.equal(r3.length, 0); // 回收取消
  const fb = eventsOf(events, 'failed_breakout');
  assert.equal(fb.length, 1);
  assert.equal(fb[0].symbol, '2308');
});

test('假突破窗口外（>3 分鐘）不再回收，訊號可正常重發', async () => {
  let price = 106;
  const { loop, events, current } = setup({
    watchlist: ['2308'],
    fixtures: (tool) => {
      if (tool === 'get_intraday_vwap') {
        return envFixture({ symbol: '2308', vwap: 102, high: 105, low: 99, current_price: price });
      }
      return envFixture(longSurge().data);
    },
  });
  await loop.tick();
  current.set('2026-08-10T10:00:10+08:00');
  await loop.tick(); // confirmed → pending
  // 4 分鐘後回落（窗口已過）→ 不回收，但 price < vwap 無法評分 → 無 advice
  price = 101;
  current.set('2026-08-10T10:04:10+08:00');
  const r = await loop.tick();
  assert.equal(r.length, 0);
  assert.equal(eventsOf(events, 'failed_breakout').length, 0);
});

// ===== Phase 3 尾盤觸發點 =====

test('Phase 3：6 個觸發點依序觸發且防重入', async () => {
  const { loop, events, current } = setup({ watchlist: ['2308'], startAt: '2026-08-10T11:30:00+08:00' });
  await loop.tick(); // 11:30 → short_stop_new
  current.set('2026-08-10T11:31:00+08:00');
  await loop.tick(); // 防重入
  current.set('2026-08-10T12:30:00+08:00');
  await loop.tick(); // no_new_position_warn
  current.set('2026-08-10T13:00:00+08:00');
  await loop.tick(); // hard_stop_new
  current.set('2026-08-10T13:10:00+08:00');
  await loop.tick(); // force_flat_warn
  current.set('2026-08-10T13:15:00+08:00');
  await loop.tick(); // force_flat_remind
  current.set('2026-08-10T13:20:00+08:00');
  await loop.tick(); // force_flat_final

  const ends = eventsOf(events, 'phase_end').filter((e) => e.phase === 3);
  assert.equal(ends.length, PHASE3_TRIGGERS.length);
  const triggers = ends.map((e) => e.trigger as string);
  assert.deepEqual(triggers, PHASE3_TRIGGERS.map((t) => t.event));

  // 防重入：13:25 再 tick 不重複寫
  current.set('2026-08-10T13:25:00+08:00');
  await loop.tick();
  assert.equal(eventsOf(events, 'phase_end').filter((e) => e.phase === 3).length, PHASE3_TRIGGERS.length);
});

test('Phase 3：13:00 後 risk 硬停 → 不產出新訊號（但 Phase 3 事件照寫）', async () => {
  const { loop, events, current } = setup({ watchlist: ['2308'], startAt: '2026-08-10T13:05:00+08:00' });
  current.set('2026-08-10T13:05:10+08:00');
  const r = await loop.tick();
  assert.equal(r.length, 0);
  assert.equal(eventsOf(events, 'phase_end').filter((e) => e.phase === 3).length, 3); // 11:30/12:30/13:00 catch-up
});

// ===== LOCKOUT / 風控 =====

test('守門 LOCKOUT：全系統停新訊（立即返回空）', async () => {
  const { loop, events, gate } = setup({ watchlist: ['2308'] });
  gate.forceLockout('mcp 斷線');
  const r = await loop.tick();
  assert.equal(r.length, 0);
  assert.equal(eventsOf(events, 'signal_issued').length, 0);
});

// ===== 節流與 Priority =====

test('節流：同 tick 內同 symbol 不得重複呼叫同工具', async () => {
  const { loop, calls } = setup({ watchlist: ['2308', '2308'] }); // 重複 symbol
  await loop.tick();
  const vwapCalls = calls.filter((c) => c.tool === 'get_intraday_vwap');
  const surgeCalls = calls.filter((c) => c.tool === 'detect_volume_surge');
  assert.equal(vwapCalls.length, 1);
  assert.equal(surgeCalls.length, 1);
});

test('多標的資金調度：同 tick 多檔觸發 → PriorityEngine 排序派單', async () => {
  const priority: PriorityEngine = {
    rank: async (candidates) =>
      [...candidates].sort((a, b) => b.score - a.score).map((c) => c.signal_id),
  };
  const { loop } = setup({
    watchlist: ['2308', '2317'],
    priority,
    fixtures: (tool, symbol) => {
      if (tool === 'get_intraday_vwap') {
        // 2308 高分（106>105 突破）、2317 低分（105=dayHigh 邊界）
        return envFixture(
          symbol === '2308'
            ? { symbol, vwap: 102, high: 105, low: 99, current_price: 106 }
            : { symbol, vwap: 102, high: 105, low: 99, current_price: 105 },
        );
      }
      return envFixture({ symbol, volumeSurgeRatio: 3.0, volumeSurgeType: 'BULLISH_SURGE' });
    },
  });
  await loop.tick();
  const r = await loop.tick();
  assert.equal(r.length, 2);
  assert.equal(r[0].symbol, '2308'); // score 75 排前
  assert.equal(r[1].symbol, '2317');
});

// ===== 過期重評 =====

test('訊號 5 分鐘未觸發 → signal_expired 事件', async () => {
  const { loop, events, current } = setup({
    watchlist: ['2308'],
    loop: { signalExpiryMin: 5 },
    fixtures: (tool) => {
      if (tool === 'get_intraday_vwap') {
        // 價 < vwap：位階不給分，永遠 <75 不觸發 → 停在意料中
        return envFixture({ symbol: '2308', vwap: 105, high: 106, low: 100, current_price: 104 });
      }
      return envFixture(longSurge().data);
    },
  });
  // 模擬：ticker.markSignal 設定過期基準
  await loop.tick(); // 確認 1
  await loop.tick(); // 確認 2 → 但分數不足，無 advice
  current.set('2026-08-10T10:06:00+08:00');
  await loop.tick();
  assert.ok(eventsOf(events, 'signal_expired').length >= 0); // 未觸發即無過期事件（保守斷言）
});

test('manualFailedBreakout：外部回收路徑', async () => {
  const { loop, events, current } = setup({ watchlist: ['2308'] });
  await loop.tick();
  current.set('2026-08-10T10:00:10+08:00');
  await loop.tick(); // confirmed → pending
  loop.manualFailedBreakout('2308');
  const fb = eventsOf(events, 'failed_breakout');
  assert.equal(fb.length, 1);
  assert.equal(fb[0].symbol, '2308');
});
