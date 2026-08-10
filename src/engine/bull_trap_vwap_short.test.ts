// T018 BULL_TRAP_VWAP_SHORT 空方策略引擎單元測試（§7）
// 覆蓋：四條件組合、逼近漲停 Veto -100、資格掃描、時間窗邊界（11:30 禁開新空）、停損停利計算、Payload/risk_warning
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BullTrapVwapShortEngine,
  scoreShortSignal,
  DEFAULT_SHORT_PARAMS,
  type ShortEvalInput,
} from './bull_trap_vwap_short.js';

// ---- 純函式評分（scoreShortSignal） ----
function baseInput(over: Partial<ShortEvalInput> = {}): ShortEvalInput {
  return {
    symbol: '2308',
    price: 1620,
    vwap: 1640,
    dayLow15m: 1625,
    volumeSurgeType: 'BEARISH_BREAKDOWN',
    priceChangePct: 2.0,
    twoCandlesBelowVwap: true,
    taifexBearish: true,
    ...over,
  };
}

test('四條件全滿足 → score 100 shouldEnter', () => {
  const r = scoreShortSignal(baseInput(), DEFAULT_SHORT_PARAMS);
  assert.equal(r.score, 100);
  assert.ok(r.shouldEnter);
  assert.equal(r.missing.length, 0);
});

test('四條件各扣一項 → 各 75 分（但條件不全不進場）', () => {
  // 缺 VWAP 下（price > vwap 但仍 < dayLow15m 1625？不行，price 1626 > dayLow 1625）→ 用 vwap 較高：price 1620 < dayLow 1625，vwap 1615 → price > vwap
  let r = scoreShortSignal(baseInput({ price: 1620, vwap: 1615 }), DEFAULT_SHORT_PARAMS);
  assert.equal(r.breakdown.below_vwap, 0);
  assert.equal(r.score, 75);
  assert.ok(!r.shouldEnter, '四條件須同時滿足');
  // 缺 BEARISH_BREAKDOWN
  r = scoreShortSignal(baseInput({ volumeSurgeType: 'BULLISH_SURGE' }), DEFAULT_SHORT_PARAMS);
  assert.equal(r.breakdown.bearish_breakdown, 0);
  assert.equal(r.score, 75);
  // 缺跌破低點
  r = scoreShortSignal(baseInput({ price: 1626, dayLow15m: 1625 }), DEFAULT_SHORT_PARAMS);
  assert.equal(r.breakdown.breakdown_low, 0);
  assert.equal(r.score, 75);
  // 缺台指黑棒（未知）
  r = scoreShortSignal(baseInput({ taifexBearish: false, taifexUnknown: true }), DEFAULT_SHORT_PARAMS);
  assert.equal(r.breakdown.market_tailwind, 0);
  assert.equal(r.score, 75);
  // 缺連續 2 根（非評分項目，屬進場條件 → score 仍 100 但 conditionsMet false 不進場）
  r = scoreShortSignal(baseInput({ twoCandlesBelowVwap: false }), DEFAULT_SHORT_PARAMS);
  assert.equal(r.score, 100);
  assert.ok(!r.shouldEnter);
});

test('今日已漲 ≥6.5% → Veto -100 → 不進場', () => {
  const r = scoreShortSignal(baseInput({ priceChangePct: 6.5 }), DEFAULT_SHORT_PARAMS);
  assert.equal(r.breakdown.veto_penalty, -100);
  assert.equal(r.score, 0);
  assert.ok(!r.shouldEnter);
  assert.match(r.missing.join(), /嚴禁放空/);
});

test('今日已漲 6.49% → 不觸發 Veto（邊界）', () => {
  const r = scoreShortSignal(baseInput({ priceChangePct: 6.49 }), DEFAULT_SHORT_PARAMS);
  assert.equal(r.breakdown.veto_penalty, 0);
  assert.equal(r.score, 100);
  assert.ok(r.shouldEnter);
});

test('台指未知 → 0 分註記（非條件失敗）', () => {
  const r = scoreShortSignal(baseInput({ taifexUnknown: true }), DEFAULT_SHORT_PARAMS);
  assert.equal(r.breakdown.market_tailwind, 0);
  assert.equal(r.score, 75);
  assert.match(r.missing.join(), /台指趨勢資料不可用/);
});

// ---- 引擎測試 ----
function makeEngine(now: Date, opts: { failScan?: boolean; failKline?: boolean } = {}) {
  const calls: string[] = [];
  const mcpCall = async (tool: string, args: Record<string, unknown>) => {
    calls.push(tool);
    const symbol = String(args.symbol ?? '');
    if (opts.failScan && tool === 'scan_daytrade_eligibility') {
      return { data: {}, _lineage: { source: 'UNKNOWN_SOURCE', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false }, _chart_meta: {} };
    }
    if (opts.failKline && tool === 'get_intraday_kline') {
      return { data: {}, _lineage: { source: 'UNKNOWN_SOURCE', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false }, _chart_meta: {} };
    }
    switch (tool) {
      case 'scan_daytrade_eligibility':
        return {
          data: { symbol, can_daytrade: true, can_short_first: true, margin_short_available: true, is_disposition: false, is_attention: false },
          _lineage: { source: 'TWSE_WEB', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false },
          _chart_meta: {},
        };
      case 'get_intraday_kline': {
        // TX → 黑棒；個股 → 2 根收 VWAP 下
        const isTx = symbol === 'TX';
        const candles = isTx
          ? [{ timestamp: '2026-08-10T09:30:00+08:00', open: 101, high: 102, low: 99, close: 100 }] // 開高走低
          : [
              { timestamp: '2026-08-10T09:29:00+08:00', open: 1630, high: 1635, low: 1620, close: 1621 },
              { timestamp: '2026-08-10T09:30:00+08:00', open: 1622, high: 1628, low: 1618, close: 1620 },
            ];
        return {
          data: { candles },
          _lineage: { source: 'TWSE', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false },
          _chart_meta: {},
        };
      }
      case 'get_intraday_quote':
        return {
          data: { symbol, change_pct: 2.0 },
          _lineage: { source: 'TWSE', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false },
          _chart_meta: {},
        };
      default:
        return {
          data: {},
          _lineage: { source: 'TWSE', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false },
          _chart_meta: {},
        };
    }
  };
  const gate = (env: { _lineage: { source: string } }) =>
    env._lineage.source === 'UNKNOWN_SOURCE'
      ? { passed: false, cause: 'unknown_source', state: 'NORMAL' }
      : { passed: true, state: 'NORMAL' };
  return { engine: new BullTrapVwapShortEngine({ mcpCall, gate, nowFn: () => now }), calls };
}

const T0930 = new Date('2026-08-10T09:30:00+08:00');

test('引擎：時間窗內四條件齊 → shouldEnter + payload（SELL_TO_OPEN + risk_warning）', async () => {
  const { engine, calls } = makeEngine(T0930);
  const r = await engine.run('2308', '台達電', 1620, 1640, 1625, 'BEARISH_BREAKDOWN', 2.0, T0930);
  assert.ok(r.eligibility.eligible);
  assert.ok(r.evaluation.shouldEnter);
  assert.ok(calls.includes('scan_daytrade_eligibility'));
  assert.ok(calls.includes('get_intraday_kline'));
  assert.ok(r.payload);
  assert.equal(r.payload!.action, 'SELL_TO_OPEN');
  assert.equal(r.payload!.strategy, 'BULL_TRAP_VWAP_SHORT');
  assert.equal(r.payload!.execution_plan.short_entry_price, 1620);
  assert.equal(r.payload!.execution_plan.stop_loss_price, 1620 * 1.015);
  assert.equal(r.payload!.execution_plan.target_price_1, 1620 * 0.98);
  assert.equal(r.payload!.execution_plan.max_holding_time_minutes, 45);
  assert.match(r.payload!.risk_warning, /距漲停板尚有/);
});

test('引擎：資格掃描失敗（can_short_first=false）→ payload null', async () => {
  const now = T0930;
  const mcpCall = async (tool: string) => {
    if (tool === 'scan_daytrade_eligibility') {
      return {
        data: { symbol: '2308', can_short_first: false, margin_short_available: true, is_disposition: false },
        _lineage: { source: 'TWSE_WEB', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false },
        _chart_meta: {},
      };
    }
    return { data: {}, _lineage: { source: 'TWSE', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false }, _chart_meta: {} };
  };
  const gate = () => ({ passed: true, state: 'NORMAL' });
  const engine = new BullTrapVwapShortEngine({ mcpCall, gate, nowFn: () => now });
  const r = await engine.run('2308', '台達電', 1620, 1640, 1625, 'BEARISH_BREAKDOWN', 2.0, now);
  assert.ok(!r.eligibility.eligible);
  assert.match(r.eligibility.reasons.join(), /未開放先賣後買/);
  assert.equal(r.payload, null);
});

test('引擎：處置股 → 資格失敗', async () => {
  const now = T0930;
  const mcpCall = async () => ({
    data: { symbol: '2308', can_short_first: true, margin_short_available: true, is_disposition: true },
    _lineage: { source: 'TWSE_WEB', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false },
    _chart_meta: {},
  });
  const gate = () => ({ passed: true, state: 'NORMAL' });
  const engine = new BullTrapVwapShortEngine({ mcpCall, gate, nowFn: () => now });
  const r = await engine.run('2308', '台達電', 1620, 1640, 1625, 'BEARISH_BREAKDOWN', 2.0, now);
  assert.ok(!r.eligibility.eligible);
  assert.match(r.eligibility.reasons.join(), /處置股/);
});

test('引擎：時間窗邊界 09:15/11:30 含，11:30:01 不含（禁開新空）', async () => {
  const { engine } = makeEngine(T0930);
  assert.ok(engine.inWindow(new Date('2026-08-10T09:15:00+08:00')));
  assert.ok(engine.inWindow(new Date('2026-08-10T11:30:00+08:00')));
  assert.ok(!engine.inWindow(new Date('2026-08-10T09:14:59+08:00')));
  assert.ok(!engine.inWindow(new Date('2026-08-10T11:30:01+08:00')));
  assert.ok(engine.noNewShortDue(new Date('2026-08-10T11:30:00+08:00')));
});

test('引擎：11:30 後禁開新空 → shouldEnter false + missing 註記', async () => {
  const { engine } = makeEngine(new Date('2026-08-10T11:30:00+08:00'));
  const r = await engine.evaluate('2308', 1620, 1640, 1625, 'BEARISH_BREAKDOWN', 2.0, new Date('2026-08-10T11:30:00+08:00'));
  assert.ok(!r.shouldEnter);
  assert.match(r.missing.join(), /禁止開新空單/);
});

test('引擎：13:00 forceCoverDue → true', () => {
  const { engine } = makeEngine(new Date('2026-08-10T13:00:00+08:00'));
  assert.ok(engine.forceCoverDue(new Date('2026-08-10T13:00:00+08:00')));
});

test('引擎：K 線守門失敗 → 連續 2 根 false + 台指 unknown → 0 分不 throw', async () => {
  const { engine } = makeEngine(T0930, { failKline: true });
  const r = await engine.evaluate('2308', 1620, 1640, 1625, 'BEARISH_BREAKDOWN', 2.0, T0930);
  // below_vwap 25 + bearish 25 + low 25 = 75；台指 unknown 0、連續 2 根 false
  assert.equal(r.score, 75);
  assert.ok(!r.shouldEnter);
  assert.match(r.missing.join(), /台指趨勢資料不可用/);
});

test('引擎：非時間窗 → 不呼叫 K 線', async () => {
  const { engine, calls } = makeEngine(new Date('2026-08-10T11:35:00+08:00'));
  const r = await engine.evaluate('2308', 1620, 1640, 1625, 'BEARISH_BREAKDOWN', 2.0, new Date('2026-08-10T11:35:00+08:00'));
  assert.ok(!r.shouldEnter);
  assert.ok(!calls.includes('get_intraday_kline'));
});

test('DEFAULT_SHORT_PARAMS 完整（§7.2/§7.4 參數）', () => {
  assert.equal(DEFAULT_SHORT_PARAMS.windowStart, '09:15');
  assert.equal(DEFAULT_SHORT_PARAMS.windowEnd, '11:30');
  assert.equal(DEFAULT_SHORT_PARAMS.priceChangeVetoPct, 6.5);
  assert.equal(DEFAULT_SHORT_PARAMS.entryThreshold, 75);
  assert.equal(DEFAULT_SHORT_PARAMS.stopLossPct, 0.015);
  assert.equal(DEFAULT_SHORT_PARAMS.takeProfitPct, 0.02);
  assert.equal(DEFAULT_SHORT_PARAMS.partialTakePct, 0.5);
  assert.equal(DEFAULT_SHORT_PARAMS.trailingStopPct, 0.008);
  assert.equal(DEFAULT_SHORT_PARAMS.maxHoldingMinutes, 45);
  assert.equal(DEFAULT_SHORT_PARAMS.noNewShortAt, '11:30');
  assert.equal(DEFAULT_SHORT_PARAMS.forceCoverAt, '13:00');
});
