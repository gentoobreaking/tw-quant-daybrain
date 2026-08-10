// T007 訊號評分模型 單元測試
// 驗收：各項目加權、Veto 優先、門檻邊界（75/79/84/85/60/59）、雙 tick 邏輯、過期重評

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SignalScoringEngine,
  TickConfirmer,
  loadScoringConfig,
  type ScoreInput,
  type ScoringConfig,
} from './scoring.js';

const CFG: ScoringConfig = {
  scoring_version: '2.1.0',
  weights: { position: 25, volume: 25, breakout: 25, market_direction: 25 },
  veto: { long_limit_up_proximity: -50, short_surge_lock: -100, generic_restriction: -100 },
  thresholds: { strong_buy: 75, watch: 60, neutral_flexible_override: 85 },
  behavior: { signal_expiry_min: 5 },
};

/** 滿分多方輸入（4×25 = 100） */
function longFull(): ScoreInput {
  return {
    direction: 'LONG',
    price: 106,
    vwap: 102,
    volumeSurgeRatio: 3.0,
    volumeSurgeType: 'BULLISH_SURGE',
    dayHigh: 105,
    dayLow15m: 99,
    taifexTrend: 'BULLISH',
    distanceToLimitUpPct: 0.05,
    dayGainPct: 0.02,
    restriction: false,
  };
}

/** 滿分空方輸入（4×25 = 100） */
function shortFull(): ScoreInput {
  return {
    direction: 'SHORT',
    price: 95,
    vwap: 100,
    volumeSurgeRatio: 1.0,
    volumeSurgeType: 'BEARISH_BREAKDOWN',
    dayHigh: 108,
    dayLow15m: 96,
    taifexTrend: 'BEARISH',
    distanceToLimitUpPct: 0.2,
    dayGainPct: 0.03,
    restriction: false,
  };
}

// ===== 各項目加權（§8.2） =====

test('滿分多方：4×25 = 100，STRONG_BUY，shouldEnter', () => {
  const engine = new SignalScoringEngine(CFG);
  const r = engine.score(longFull());
  assert.equal(r.total, 100);
  assert.deepEqual(r.breakdown, { level: 25, volume: 25, breakout: 25, market: 25, veto_penalty: 0 });
  assert.equal(r.grade, 'STRONG_BUY');
  assert.equal(r.shouldEnter, true);
  assert.equal(r.veto_reasons.length, 0);
});

test('滿分空方：4×25 = 100', () => {
  const engine = new SignalScoringEngine(CFG);
  const r = engine.score(shortFull());
  assert.equal(r.total, 100);
  assert.equal(r.grade, 'STRONG_BUY'); // 空方以 STRONG_SELL 表示（grade 對應行動）
  assert.equal(r.shouldEnter, true);
});

test('各項目獨立加權：缺一項 → 75（仍 STRONG_BUY）', () => {
  const engine = new SignalScoringEngine(CFG);
  const input = longFull();
  input.taifexTrend = 'NEUTRAL'; // 大盤方向 0
  const r = engine.score(input);
  assert.equal(r.total, 75);
  assert.equal(r.breakdown.market, 0);
  assert.equal(r.grade, 'STRONG_BUY');
  assert.equal(r.shouldEnter, true);
});

test('位階條件反向 → 不加分（多：價 ≤ VWAP）', () => {
  const engine = new SignalScoringEngine(CFG);
  const input = longFull();
  input.price = 102; // = VWAP，非 > VWAP
  input.dayHigh = 102; // 保持突破加分不受影響
  const r = engine.score(input);
  assert.equal(r.breakdown.level, 0);
  assert.equal(r.total, 75); // 量能+突破+大盤 = 75
});

test('量能未達門檻 → 不加分（多：ratio < 2.5）', () => {
  const engine = new SignalScoringEngine(CFG, { volumeSurgeThreshold: 2.5 });
  const input = longFull();
  input.volumeSurgeRatio = 2.0;
  const r = engine.score(input);
  assert.equal(r.breakdown.volume, 0);
  assert.equal(r.total, 75);
});

test('空方量能需 BEARISH_BREAKDOWN 才加分', () => {
  const engine = new SignalScoringEngine(CFG);
  const input = shortFull();
  input.volumeSurgeType = 'BULLISH_SURGE';
  const r = engine.score(input);
  assert.equal(r.breakdown.volume, 0);
  assert.equal(r.total, 75);
});

// ===== Veto 優先（§8.2） =====

test('多方距漲停 < 1.5%：-50 扣分非否決（100-50=50 → IGNORE）', () => {
  const engine = new SignalScoringEngine(CFG);
  const input = longFull();
  input.distanceToLimitUpPct = 0.01; // < 1.5%
  const r = engine.score(input);
  assert.equal(r.total, 50);
  assert.equal(r.breakdown.veto_penalty, -50);
  assert.equal(r.grade, 'IGNORE');
  assert.equal(r.shouldEnter, false);
  assert.equal(r.veto_reasons.length, 1);
  assert.match(r.veto_reasons[0], /距漲停/);
});

test('空方今日漲幅 ≥ 6.5%：-100 否決（total=-100）', () => {
  const engine = new SignalScoringEngine(CFG);
  const input = shortFull();
  input.dayGainPct = 0.07;
  const r = engine.score(input);
  assert.equal(r.total, -100);
  assert.equal(r.shouldEnter, false);
  assert.match(r.veto_reasons[0], /漲幅 ≥ 6.5%/);
});

test('通用風控限制：-100 否決', () => {
  const engine = new SignalScoringEngine(CFG);
  const input = longFull();
  input.restriction = true;
  const r = engine.score(input);
  assert.equal(r.total, -100);
  assert.equal(r.shouldEnter, false);
  assert.match(r.veto_reasons[0], /處置/);
});

test('Veto -100 不與其他分數加總（否決優先）', () => {
  const engine = new SignalScoringEngine(CFG);
  const input = shortFull();
  input.restriction = true;
  const r = engine.score(input);
  assert.equal(r.total, -100); // 非 100-100=0
  assert.equal(r.grade, 'IGNORE');
});

// ===== 門檻邊界（§8.3） =====

test('門檻邊界（gradeOf）：75 STRONG_BUY、74 WATCH、60 WATCH、59 IGNORE', () => {
  const engine = new SignalScoringEngine(CFG);
  assert.equal(engine.gradeOf(75), 'STRONG_BUY');
  assert.equal(engine.gradeOf(74), 'WATCH');
  assert.equal(engine.gradeOf(60), 'WATCH');
  assert.equal(engine.gradeOf(59), 'IGNORE');
});

test('門檻邊界（score.shouldEnter）：100/75 進場、50 不進場', () => {
  const engine = new SignalScoringEngine(CFG);
  assert.equal(engine.score(longFull()).shouldEnter, true); // 100
  const input75 = longFull();
  input75.taifexTrend = 'NEUTRAL'; // 75
  assert.equal(engine.score(input75).shouldEnter, true); // 75 = 門檻
  const input50 = longFull();
  input50.taifexTrend = 'NEUTRAL';
  input50.price = 102;
  input50.dayHigh = 102; // 位階+突破 0 → 50
  assert.equal(engine.score(input50).shouldEnter, false); // 50 < 60
});

test('NEUTRAL_FLEXIBLE 日門檻提高至 85（§5.3）', () => {
  const engine = new SignalScoringEngine(CFG, { neutralFlexible: true });
  const input = longFull();
  input.taifexTrend = 'NEUTRAL'; // 75 分
  const r = engine.score(input);
  assert.equal(r.total, 75);
  assert.equal(r.shouldEnter, false); // 75 < 85，NEUTRAL 日不進場
  const input85 = longFull(); // 100 分
  const r2 = engine.score(input85);
  assert.equal(r2.shouldEnter, true); // 100 ≥ 85
});

test('進場門檻可覆寫（SCORE_THRESHOLD=80）', () => {
  const engine = new SignalScoringEngine(CFG, { entryThreshold: 80 });
  const input = longFull();
  input.taifexTrend = 'NEUTRAL'; // 75
  const r = engine.score(input);
  assert.equal(r.shouldEnter, false);
});

// ===== 輸出契約（§14.2） =====

test('評分輸出含 score_breakdown 與 scoring_version', () => {
  const engine = new SignalScoringEngine(CFG);
  const r = engine.score(longFull());
  assert.deepEqual(r.breakdown, { level: 25, volume: 25, breakout: 25, market: 25, veto_penalty: 0 });
  assert.equal(r.scoring_version, '2.1.0');
});

// ===== loadScoringConfig（Config-Driven） =====

test('loadScoringConfig：自 YAML 載入權重/門檻/veto', () => {
  const cfg = loadScoringConfig({
    scoring_version: '2.1.0',
    weights: { position: 25, volume: 25, breakout: 25, market_direction: 25 },
    veto: { long_limit_up_proximity: -50, short_surge_lock: -100, generic_restriction: -100 },
    thresholds: { strong_buy: 75, watch: 60, neutral_flexible_override: 85 },
    behavior: { signal_expiry_min: 5 },
  });
  assert.equal(cfg.scoring_version, '2.1.0');
  assert.equal(cfg.thresholds.strong_buy, 75);
  assert.equal(cfg.thresholds.neutral_flexible_override, 85);
  assert.equal(cfg.veto.short_surge_lock, -100);
});

test('loadScoringConfig：缺欄位以預設值補齊', () => {
  const cfg = loadScoringConfig(undefined);
  assert.equal(cfg.weights.position, 25);
  assert.equal(cfg.thresholds.strong_buy, 75);
  assert.equal(cfg.behavior.signal_expiry_min, 5);
});

// ===== 雙 tick 確認（§4 Phase 2） =====

test('雙 tick 確認：第一次 false、第二次 true（進入完整評分）', () => {
  const t = new TickConfirmer(2);
  assert.equal(t.confirm('2308'), false);
  assert.equal(t.confirm('2308'), true);
});

test('雙 tick 確認：不同 symbol 獨立計數', () => {
  const t = new TickConfirmer(2);
  assert.equal(t.confirm('2308'), false);
  assert.equal(t.confirm('2330'), false);
  assert.equal(t.confirm('2308'), true);
  assert.equal(t.confirm('2330'), true);
});

test('雙 tick 確認：consume 後重新計數', () => {
  const t = new TickConfirmer(2);
  t.confirm('2308');
  t.confirm('2308');
  t.consume('2308');
  assert.equal(t.confirm('2308'), false); // 重新從 1 開始
});

// ===== 過期重評（§8.3） =====

test('訊號 5 分鐘未觸發 → 過期重評', () => {
  const base = new Date('2026-08-10T09:00:00+08:00');
  const t = new TickConfirmer(2, () => base);
  t.markSignal('2308', base.toISOString());
  assert.equal(t.isExpired('2308', 5, new Date(base.getTime() + 4 * 60_000)), false);
  assert.equal(t.isExpired('2308', 5, new Date(base.getTime() + 5 * 60_000)), true);
  assert.equal(t.isExpired('2308', 5, new Date(base.getTime() + 6 * 60_000)), true);
});

test('未產生訊號 → 不過期', () => {
  const t = new TickConfirmer(2);
  t.confirm('2308');
  assert.equal(t.isExpired('2308'), false);
});
