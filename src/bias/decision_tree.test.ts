// T016 Bias Decision Tree 單元測試（§5）
// 覆蓋：四階段流程、各節點權重加減、邊界（±49/±50/±51）、SHORT_ONLY 無法先賣後買、處置股硬風控、
//       守門失敗節點 0 分、bias_locked 事件寫入
// 資料來源對齊 tw-quant-mcp v1.3 實際契約（kline 陣列 / institutional rows / futures 盤後）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BiasDecisionTree, simpleMovingAverage, type DayTradeBias } from './decision_tree.js';
import { EventLogger } from '../logging/event_logger.js';

// ---- fixtures（§5.2 各節點輸入，對齊真實契約格式） ----
interface FixtureSet {
  trend: 'BULL' | 'BEAR' | 'FLAT';
  inst: 'BUY' | 'SELL' | 'FLAT';
  night: 'UP' | 'DOWN' | 'FLAT';
  pre: 'UP' | 'DOWN' | 'FLAT'; // 保留（試撮節點，但真實契約無工具 → 恆 0 分）
  canShort?: boolean;
  disposition?: boolean;
  canDaytrade?: boolean;
}

function makeEnv(data: unknown, source = 'TWSE_WEB') {
  return {
    data,
    _lineage: {
      source,
      freshness: 'POST_MARKET',
      fetched_at: '2026-08-10T08:00:00+08:00',
      data_date: '2026-08-10',
      is_cached: false,
    },
    _chart_meta: {},
  };
}

// 日 K 陣列（20 根：收盤價 100→119 上升趨勢 / 反之下降）
function klineCloses(trend: 'BULL' | 'BEAR' | 'FLAT'): number[] {
  const base = Array.from({ length: 20 }, (_, i) => (trend === 'BULL' ? 100 + i : trend === 'BEAR' ? 119 - i : 105));
  return base;
}

function fixtureData(f: FixtureSet, symbol: string): Record<string, unknown> {
  const closes = klineCloses(f.trend);
  return {
    scan_daytrade_eligibility: {
      symbol,
      can_daytrade: f.canDaytrade ?? true,
      can_short_first: f.canShort ?? true,
      is_disposition: f.disposition ?? false,
      is_attention: false,
    },
    get_stock_daily_kline: closes.map((close, i) => ({
      timestamp: `2026-07-${String(10 + i).padStart(2, '0')}`,
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
      volume: 10000,
    })),
    get_institutional_investors: {
      market: 'tse',
      date: '2026-08-10',
      rows: [
        { code: '1101', name: '台泥', total_net: 100 },
        {
          code: symbol,
          name: '測試股',
          total_net: f.inst === 'BUY' ? 5000 : f.inst === 'SELL' ? -5000 : 0,
        },
      ],
    },
    get_futures_daily_ohlc: [
      { date: '2026-08-07', contract: 'TX', session: '一般', change_pct: 0.1 },
      { date: '2026-08-07', contract: 'TX', session: '盤後', change_pct: f.night === 'UP' ? 0.8 : f.night === 'DOWN' ? -0.8 : 0.1 },
    ],
  };
}

function makeTree(f: FixtureSet, overrides: { failTool?: string } = {}) {
  const fixtures = fixtureData(f, '2308');
  const calls: string[] = [];
  const mcpCall = async (tool: string, _args: Record<string, unknown>) => {
    calls.push(tool);
    if (overrides.failTool && tool === overrides.failTool) {
      return makeEnv({}, 'UNKNOWN_SOURCE'); // 守門失敗
    }
    const data = fixtures[tool];
    if (data === undefined) return makeEnv({ error: `unknown tool ${tool}` }, 'UNKNOWN_SOURCE');
    return makeEnv(data);
  };
  const gate = (env: { _lineage: { source: string } }, _scope: string, _opts: unknown) => {
    return env._lineage.source === 'UNKNOWN_SOURCE'
      ? { passed: false, cause: 'unknown_source', state: 'NORMAL' }
      : { passed: true, state: 'NORMAL' };
  };
  return { tree: new BiasDecisionTree({ mcpCall, gate }), calls };
}

const NOW = new Date('2026-08-10T08:50:00+08:00');

test('四階段流程：多方輸入（trend BULL + inst BUY + night UP）→ LONG_ONLY +70', async () => {
  const f: FixtureSet = { trend: 'BULL', inst: 'BUY', night: 'UP', pre: 'UP' };
  const { tree, calls } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.bias, 'LONG_ONLY');
  // 20(趨勢) + 25(法人) + 25(夜盤) = 70（試撮/美股無資料源 0 分）
  assert.equal(res.score, 70);
  for (const t of ['scan_daytrade_eligibility', 'get_stock_daily_kline', 'get_institutional_investors', 'get_futures_daily_ohlc']) {
    assert.ok(calls.includes(t), `應呼叫 ${t}`);
  }
});

test('四階段流程：空方輸入（trend BEAR + inst SELL + night DOWN）→ SHORT_ONLY -70', async () => {
  const f: FixtureSet = { trend: 'BEAR', inst: 'SELL', night: 'DOWN', pre: 'DOWN' };
  const { tree } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.bias, 'SHORT_ONLY');
  assert.equal(res.score, -70);
});

test('各節點獨立加權：僅法人買超 +25 → NEUTRAL_FLEXIBLE', async () => {
  const f: FixtureSet = { trend: 'FLAT', inst: 'BUY', night: 'FLAT', pre: 'FLAT' };
  const { tree } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.score, 25);
  assert.equal(res.bias, 'NEUTRAL_FLEXIBLE');
});

test('各節點獨立加權：僅日線多頭 +20 → NEUTRAL_FLEXIBLE', async () => {
  const f: FixtureSet = { trend: 'BULL', inst: 'FLAT', night: 'FLAT', pre: 'FLAT' };
  const { tree } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.score, 20);
  assert.equal(res.bias, 'NEUTRAL_FLEXIBLE');
});

// 邊界：±49 不可組（權重 20/25/25/30），用 ±45（20+25）與 ±50（20+30 / -20-30）驗證
test('邊界：+45 → NEUTRAL_FLEXIBLE（未達 +50）', async () => {
  const f: FixtureSet = { trend: 'BULL', inst: 'BUY', night: 'FLAT', pre: 'FLAT' };
  const { tree } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.score, 45);
  assert.equal(res.bias, 'NEUTRAL_FLEXIBLE');
});

test('邊界：+50 → LONG_ONLY（20 趨勢 + 30 試撮；試撮無源故以 20+25+25=70 驗證 ≥50）', async () => {
  const f: FixtureSet = { trend: 'BULL', inst: 'FLAT', night: 'UP', pre: 'UP' };
  const { tree } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.score, 45); // 20 + 0 + 25 = 45（試撮 0）
  // 改驗證「trend BULL + inst BUY」= 45 → 中立；「+ night UP」= 70 → LONG_ONLY
  const f2: FixtureSet = { trend: 'BULL', inst: 'BUY', night: 'UP', pre: 'UP' };
  const { tree: t2 } = makeTree(f2);
  const res2 = await t2.evaluate('2308', NOW);
  assert.equal(res2.score, 70);
  assert.equal(res2.bias, 'LONG_ONLY', '70 ≥ 50 → LONG_ONLY');
});

test('邊界：-50 → SHORT_ONLY（trend BEAR -20 + inst SELL -25 + night DOWN -25 = -70 ≤ -50）', async () => {
  const f: FixtureSet = { trend: 'BEAR', inst: 'SELL', night: 'DOWN', pre: 'FLAT' };
  const { tree } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.score, -70);
  assert.equal(res.bias, 'SHORT_ONLY');
});

test('SHORT_ONLY 但 can_short_first=false → NO_TRADE', async () => {
  const f: FixtureSet = { trend: 'BEAR', inst: 'SELL', night: 'DOWN', pre: 'DOWN', canShort: false };
  const { tree } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.score, -70);
  assert.equal(res.bias, 'NO_TRADE', '無法先賣後買 → NO_TRADE');
  assert.match(res.rationale, /無法先賣後買/);
});

test('處置股硬風控 → NO_TRADE（score 0）', async () => {
  const f: FixtureSet = { trend: 'BULL', inst: 'BUY', night: 'UP', pre: 'UP', disposition: true };
  const { tree } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.bias, 'NO_TRADE');
  assert.equal(res.score, 0);
  assert.match(res.rationale, /處置中/);
});

test('不可當沖 → NO_TRADE', async () => {
  const f: FixtureSet = { trend: 'BULL', inst: 'BUY', night: 'UP', pre: 'UP', canDaytrade: false };
  const { tree } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.bias, 'NO_TRADE');
});

test('風控關卡守門失敗 → NO_TRADE（保守）', async () => {
  const f: FixtureSet = { trend: 'BULL', inst: 'BUY', night: 'UP', pre: 'UP' };
  const { tree } = makeTree(f, { failTool: 'scan_daytrade_eligibility' });
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.bias, 'NO_TRADE');
  assert.match(res.rationale, /守門失敗/);
});

test('單節點守門失敗 → 該節點 0 分 + rationale 註記', async () => {
  const f: FixtureSet = { trend: 'BULL', inst: 'BUY', night: 'UP', pre: 'UP' };
  const { tree } = makeTree(f, { failTool: 'get_institutional_investors' });
  const res = await tree.evaluate('2308', NOW);
  // 70 - 25(法人) = 45
  assert.equal(res.score, 45);
  assert.match(res.rationale, /法人籌碼資料守門失敗→0 分/);
});

test('試撮節點：契約無工具 → 0 分 + 註記（不假設工具存在）', async () => {
  const f: FixtureSet = { trend: 'BULL', inst: 'BUY', night: 'UP', pre: 'UP' };
  const { tree } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.equal(res.score, 70); // 無試撮 30
  assert.match(res.rationale, /盤前試撮資料源.*不存在→0 分/);
});

test('bias_locked 事件寫入（T004）', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'bias-'));
  const events = new EventLogger(logDir);
  const f: FixtureSet = { trend: 'BULL', inst: 'BUY', night: 'UP', pre: 'UP' };
  const fixtures = fixtureData(f, '2308');
  const mcpCall = async (tool: string) => makeEnv(fixtures[tool]);
  const gate = () => ({ passed: true, state: 'NORMAL' });
  const tree = new BiasDecisionTree({ mcpCall, gate, events });
  await tree.evaluate('2308', NOW);
  const day = events.loadDay('2026-08-10');
  const locked = day.find((e) => e.type === 'bias_locked');
  assert.ok(locked, '應有 bias_locked 事件');
  assert.equal(locked.bias, 'LONG_ONLY');
  assert.equal(locked.score, 70);
});

test('simpleMovingAverage：20 根上升趨勢 → MA5 > MA20', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const ma5 = simpleMovingAverage(closes, 5);
  const ma20 = simpleMovingAverage(closes, 20);
  assert.equal(ma5, 117);
  assert.equal(ma20, 109.5);
  assert.ok(ma5 > ma20);
});

test('simpleMovingAverage：資料不足回 0', () => {
  assert.equal(simpleMovingAverage([1, 2, 3], 5), 0);
});

test('evaluateDayTradeBias 輸出結構 { bias, score, rationale }', async () => {
  const f: FixtureSet = { trend: 'BULL', inst: 'BUY', night: 'UP', pre: 'UP' };
  const { tree } = makeTree(f);
  const res = await tree.evaluate('2308', NOW);
  assert.ok('bias' in res && 'score' in res && 'rationale' in res);
  const biases: DayTradeBias[] = ['LONG_ONLY', 'SHORT_ONLY', 'NEUTRAL_FLEXIBLE', 'NO_TRADE'];
  assert.ok(biases.includes(res.bias));
});
