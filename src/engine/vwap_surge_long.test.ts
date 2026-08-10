// T017 VWAP_SURGE_LONG 策略引擎單元測試（§6）
// 覆蓋：四條件組合、評分邊界（74/75）、距漲停 Veto 扣分、時間窗邊界、停損停利計算、Payload 結構
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VwapSurgeLongEngine, scoreLongSignal, DEFAULT_LONG_PARAMS, type LongEvalInput } from './vwap_surge_long.js';

// ---- 純函式評分測試（scoreLongSignal） ----
function baseInput(over: Partial<LongEvalInput> = {}): LongEvalInput {
  return {
    symbol: '2308',
    price: 1650,
    vwap: 1640,
    dayHigh: 1645,
    volumeSurgeRatio: 3.0,
    isSurge: true,
    distanceToLimitUpPct: 0.05,
    taifexBullish: true,
    ...over,
  };
}

test('四條件全滿足 → score 100 shouldEnter', () => {
  const r = scoreLongSignal(baseInput(), DEFAULT_LONG_PARAMS);
  assert.equal(r.score, 100);
  assert.ok(r.shouldEnter);
  assert.equal(r.missing.length, 0);
});

test('四條件各扣一項 → 各 75 分', () => {
  // 缺 VWAP 站穩：price(1645) 低於 vwap(1646) 但仍 ≥ dayHigh(1645)（僅影響 VWAP 條件）
  let r = scoreLongSignal(baseInput({ price: 1645, vwap: 1646 }), DEFAULT_LONG_PARAMS);
  assert.equal(r.breakdown.vwap_hold, 0);
  assert.equal(r.breakdown.breakout, 25);
  assert.equal(r.score, 75);
  // 缺爆量
  r = scoreLongSignal(baseInput({ isSurge: false, volumeSurgeRatio: 1.5 }), DEFAULT_LONG_PARAMS);
  assert.equal(r.breakdown.volume_surge, 0);
  assert.equal(r.score, 75);
  // 缺突破（price < dayHigh）
  r = scoreLongSignal(baseInput({ price: 1644, dayHigh: 1645 }), DEFAULT_LONG_PARAMS);
  assert.equal(r.breakdown.breakout, 0);
  assert.equal(r.score, 75);
  // 缺台指順風（台指未知）
  r = scoreLongSignal(baseInput({ taifexBullish: false, taifexUnknown: true }), DEFAULT_LONG_PARAMS);
  assert.equal(r.breakdown.market_tailwind, 0);
  assert.equal(r.score, 75);
});

test('評分邊界：75 為門檻但四條件須同時滿足（缺一條件不進場）', () => {
  // 缺 VWAP：score 75 ≥ 75，但 §6.2 四條件須同時滿足 → shouldEnter false
  const r = scoreLongSignal(baseInput({ price: 1645, vwap: 1646 }), DEFAULT_LONG_PARAMS);
  assert.equal(r.score, 75);
  assert.ok(!r.conditionsMet);
  assert.ok(!r.shouldEnter, '條件不全 → 不進場');
  // 四條件全滿足 → 進場
  const full = scoreLongSignal(baseInput(), DEFAULT_LONG_PARAMS);
  assert.ok(full.conditionsMet && full.shouldEnter);
});

test('距漲停 <1.5% → Veto -50 → 不進場', () => {
  const r = scoreLongSignal(baseInput({ distanceToLimitUpPct: 0.01 }), DEFAULT_LONG_PARAMS);
  assert.equal(r.breakdown.veto_penalty, -50);
  assert.equal(r.score, 50);
  assert.ok(!r.shouldEnter);
});

test('距漲停恰 1.5% → 不扣分（邊界）', () => {
  const r = scoreLongSignal(baseInput({ distanceToLimitUpPct: 0.015 }), DEFAULT_LONG_PARAMS);
  assert.equal(r.breakdown.veto_penalty, 0);
  assert.equal(r.score, 100);
  assert.ok(r.shouldEnter);
});

test('VWAP 偏離 >1.5% → 不站穩（追高）', () => {
  const r = scoreLongSignal(baseInput({ price: 1640 * 1.02 }), DEFAULT_LONG_PARAMS);
  assert.equal(r.breakdown.vwap_hold, 0);
  assert.match(r.missing[0], /VWAP 未站穩/);
});

test('台指未知 → 不給分但註記（非條件失敗）', () => {
  const r = scoreLongSignal(baseInput({ taifexUnknown: true }), DEFAULT_LONG_PARAMS);
  assert.equal(r.breakdown.market_tailwind, 0);
  assert.equal(r.score, 75);
  assert.match(r.missing.join(), /台指趨勢資料不可用/);
});

// ---- 引擎測試（時間窗 / payload / 事件） ----
function makeEngine(now: Date, params = {}) {
  const calls: string[] = [];
  const mcpCall = async (tool: string, _args: Record<string, unknown>) => {
    calls.push(tool);
    if (tool === 'get_intraday_kline') {
      // 台指 1 分 K：紅棒
      return {
        data: { candles: [{ timestamp: '2026-08-10T09:30:00+08:00', open: 100, high: 102, low: 99, close: 101 }] },
        _lineage: { source: 'TWSE', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false },
        _chart_meta: {},
      };
    }
    return {
      data: {},
      _lineage: { source: 'TWSE', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false },
      _chart_meta: {},
    };
  };
  const gate = () => ({ passed: true, state: 'NORMAL' });
  return { engine: new VwapSurgeLongEngine({ mcpCall, gate, nowFn: () => now, params }), calls };
}

const T0930 = new Date('2026-08-10T09:30:00+08:00');

test('引擎：時間窗內四條件齊 → shouldEnter + payload', async () => {
  const { engine, calls } = makeEngine(T0930);
  const evalRes = await engine.evaluate(
    '2308', 1650, 1640, 1645,
    { is_surge: true, volumeSurgeRatio: 3.0, volumeSurgeType: 'BULLISH_SURGE' },
    0.05, T0930,
  );
  assert.ok(evalRes.shouldEnter);
  assert.ok(calls.includes('get_intraday_kline'), '應呼叫台指 K 線');
  // 測試 run() 產 payload + signal_issued 事件
  const { payload } = await engine.run(
    '2308', '台達電', 1650, 1640, 1645,
    { is_surge: true, volumeSurgeRatio: 3.0 }, 0.05, T0930,
  );
  assert.ok(payload);
  assert.equal(payload!.action, 'BUY_TO_OPEN');
  assert.equal(payload!.strategy, 'VWAP_SURGE_LONG');
  assert.equal(payload!.execution_plan.entry_price, 1650);
  assert.equal(payload!.execution_plan.stop_loss_price, 1650 * 0.985);
  assert.equal(payload!.execution_plan.target_price_1, 1650 * 1.02);
  assert.equal(payload!.execution_plan.max_holding_time_minutes, 60);
});

test('引擎：時間窗邊界 09:05 / 11:30 含入，09:04 不含', async () => {
  const { engine } = makeEngine(T0930);
  assert.ok(engine.inWindow(new Date('2026-08-10T09:05:00+08:00')));
  assert.ok(engine.inWindow(new Date('2026-08-10T11:30:00+08:00')));
  assert.ok(!engine.inWindow(new Date('2026-08-10T09:04:59+08:00')));
  assert.ok(!engine.inWindow(new Date('2026-08-10T11:30:01+08:00')));
});

test('引擎：12:30 停訊 → shouldEnter false', async () => {
  const { engine } = makeEngine(new Date('2026-08-10T12:30:00+08:00'));
  const r = await engine.evaluate('2308', 1650, 1640, 1645, { is_surge: true, volumeSurgeRatio: 3.0 }, 0.05, new Date('2026-08-10T12:30:00+08:00'));
  assert.ok(!r.shouldEnter);
  assert.match(r.missing.join(), /停止發訊/);
});

test('引擎：13:10 forceFlatDue → true', () => {
  const { engine } = makeEngine(new Date('2026-08-10T13:10:00+08:00'));
  assert.ok(engine.forceFlatDue(new Date('2026-08-10T13:10:00+08:00')));
});

test('引擎：台指 K 線守門失敗 → unknown → 0 分不 throw', async () => {
  const now = T0930;
  const mcpCall = async () => {
    return { data: {}, _lineage: { source: 'UNKNOWN_SOURCE', freshness: 'REALTIME_INTRADAY', fetched_at: now.toISOString(), is_cached: false }, _chart_meta: {} };
  };
  const gate = (env: { _lineage: { source: string } }) =>
    env._lineage.source === 'UNKNOWN_SOURCE' ? { passed: false, cause: 'unknown_source', state: 'NORMAL' } : { passed: true, state: 'NORMAL' };
  const engine = new VwapSurgeLongEngine({ mcpCall, gate, nowFn: () => now });
  const r = await engine.evaluate('2308', 1650, 1640, 1645, { is_surge: true, volumeSurgeRatio: 3.0 }, 0.05, now);
  assert.equal(r.score, 75);
  assert.match(r.missing.join(), /台指趨勢資料不可用/);
});

test('引擎：非時間窗 → 不呼叫台指 K（節省呼叫）', async () => {
  const { engine, calls } = makeEngine(new Date('2026-08-10T12:35:00+08:00'));
  const r = await engine.evaluate('2308', 1650, 1640, 1645, { is_surge: true, volumeSurgeRatio: 3.0 }, 0.05, new Date('2026-08-10T12:35:00+08:00'));
  assert.ok(!r.shouldEnter);
  assert.ok(!calls.includes('get_intraday_kline'));
});

test('DEFAULT_LONG_PARAMS 完整（§6.2/§6.4 參數）', () => {
  assert.equal(DEFAULT_LONG_PARAMS.windowStart, '09:05');
  assert.equal(DEFAULT_LONG_PARAMS.windowEnd, '11:30');
  assert.equal(DEFAULT_LONG_PARAMS.volumeSurgeMin, 2.5);
  assert.equal(DEFAULT_LONG_PARAMS.entryThreshold, 75);
  assert.equal(DEFAULT_LONG_PARAMS.stopLossPct, 0.015);
  assert.equal(DEFAULT_LONG_PARAMS.takeProfitPct, 0.02);
  assert.equal(DEFAULT_LONG_PARAMS.partialTakePct, 0.5);
  assert.equal(DEFAULT_LONG_PARAMS.trailingStopPct, 0.01);
  assert.equal(DEFAULT_LONG_PARAMS.stopSignalAt, '12:30');
  assert.equal(DEFAULT_LONG_PARAMS.forceFlatAt, '13:10');
});
