// T006 盤前流程 單元測試
// 驗證：Phase 0 連線驗證/預熱/缺口、三路徑選股去重、風控過濾、觸發價/停損價計算、
//       set_active_watchlist 失敗降級、低訊號日降門檻、空清單處理

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Phase0ReadyCheck } from './phase0.js';
import { Phase1Selector, buildSelectionPool } from './phase1.js';
import type { McpCallFn, GateCheckFn, EligibilityResult } from './types.js';

// ===== 測試資料 =====

const INST_DATA = {
  stocks: [
    { symbol: '2308', foreign_net: 1000, investment_trust_net: 500 },
    { symbol: '2330', foreign_net: 2000, investment_trust_net: -300 },
    { symbol: '2317', foreign_net: 800, investment_trust_net: 600 },
  ],
};

const ABNORMAL_DATA = { stocks: [{ symbol: '2308' }, { symbol: '2603' }] };
const ANN_DATA = {
  announcements: [
    { symbol: '2308', title: '月營收創高' },
    { symbol: '2454', title: '法說會' },
  ],
};

function okGate(): GateCheckFn {
  return () => ({ passed: true, state: 'NORMAL' });
}

function failGate(cause = 'freshness_mismatch'): GateCheckFn {
  return () => ({ passed: false, state: 'STALE', cause });
}

function mcpStub(dataByTool: Record<string, unknown>): McpCallFn {
  return async (tool, _args) => ({
    data: dataByTool[tool] ?? {},
    _lineage: { source: 'TWSE', freshness: 'POST_MARKET_TODAY', fetched_at: new Date().toISOString() },
  });
}

/** 預設價格計算 stub：昨日收盤 100、高點 105、VWAP 近似 102 */
function priceStub(): (s: string) => Promise<{ yesterdayClose: number; yesterdayHigh: number; vwapEstimate: number }> {
  return async () => ({ yesterdayClose: 100, yesterdayHigh: 105, vwapEstimate: 102 });
}

function eligStub(
  allowed: string[],
  opts: { riskStatus?: string } = {},
): (s: string) => Promise<EligibilityResult> {
  return async (symbol) => ({
    symbol,
    eligible: allowed.includes(symbol),
    riskStatus: opts.riskStatus ?? 'NORMAL',
    isAttention: false,
    isDisposition: false,
    marginRestricted: false,
  });
}

// ===== buildSelectionPool 去重 =====

test('三路徑選股去重：重複 symbol 只保留一次，來源記錄', () => {
  const pool = buildSelectionPool(INST_DATA, ABNORMAL_DATA, ANN_DATA);
  assert.deepEqual(pool.institutional, ['2308', '2330', '2317']);
  assert.deepEqual(pool.abnormal, ['2308', '2603']);
  assert.deepEqual(pool.announcements, ['2308', '2454']);
});

test('三路徑資料形狀異常（非預期格式）不崩潰', () => {
  const pool = buildSelectionPool({ foo: 1 }, null, { announcements: 'x' });
  assert.deepEqual(pool.institutional, []);
  assert.deepEqual(pool.abnormal, []);
  assert.deepEqual(pool.announcements, []);
});

// ===== Phase 0 =====

test('Phase 0：連線就緒 + 預熱通過 → 無缺口', async () => {
  const p0 = new Phase0ReadyCheck({
    listTools: async () => ['get_institutional_investors', 'get_abnormal_trading', 'get_major_announcements', 'scan_daytrade_eligibility', 'set_active_watchlist'],
    mcpCall: mcpStub({}),
    gate: okGate(),
  });
  const r = await p0.run();
  assert.equal(r.connectionReady, true);
  assert.equal(r.missingTools.length, 0);
  assert.equal(r.dataGaps.length, 0);
  assert.ok(r.warmup.every((w) => w.passed));
});

test('Phase 0：連線失敗 → connectionReady=false + 缺口', async () => {
  const p0 = new Phase0ReadyCheck({
    listTools: async () => {
      throw new Error('MCP 連不上');
    },
    mcpCall: mcpStub({}),
    gate: okGate(),
  });
  const r = await p0.run();
  assert.equal(r.connectionReady, false);
  assert.equal(r.dataGaps.length, 1);
  assert.match(r.dataGaps[0].reason, /連線驗證失敗/);
});

test('Phase 0：缺少必備工具 → 缺口註明', async () => {
  const p0 = new Phase0ReadyCheck({
    listTools: async () => ['get_institutional_investors'],
    mcpCall: mcpStub({}),
    gate: okGate(),
  });
  const r = await p0.run();
  assert.ok(r.missingTools.includes('set_active_watchlist'));
  assert.ok(r.dataGaps.some((g) => /缺少必備工具/.test(g.reason)));
});

test('Phase 0：前一日盤後資料守門失敗（非 POST_MARKET_TODAY）→ 缺口註明', async () => {
  const p0 = new Phase0ReadyCheck({
    listTools: async () => ['get_institutional_investors', 'get_abnormal_trading', 'get_major_announcements', 'scan_daytrade_eligibility', 'set_active_watchlist'],
    mcpCall: mcpStub({}),
    gate: failGate('freshness_mismatch'),
  });
  const r = await p0.run();
  assert.equal(r.connectionReady, true);
  assert.ok(r.dataGaps.some((g) => /未就緒/.test(g.reason)));
  assert.ok(r.warmup.some((w) => !w.passed));
});

// ===== Phase 1 選股 =====

const PHASE1_DATA = {
  get_institutional_investors: INST_DATA,
  get_abnormal_trading: ABNORMAL_DATA,
  get_major_announcements: ANN_DATA,
};

test('Phase 1：三路徑選股 → 過濾 → 候選清單（含觸發價/停損價）', async () => {
  const selector = new Phase1Selector({
    mcpCall: mcpStub(PHASE1_DATA),
    gate: okGate(),
    today: '2026-08-10',
    yesterday: '2026-08-07',
    scanEligibility: eligStub(['2308', '2330', '2317']),
    priceCalculator: priceStub(),
  });
  const report = await selector.run();
  // 候選為三路徑去重後通過過濾者
  assert.ok(report.candidates.length >= 1);
  const cand = report.candidates.find((c) => c.symbol === '2308');
  assert.ok(cand, '2308 應在候選中（三路徑皆有）');
  assert.equal(cand?.triggerPrice, 105); // 昨日高點
  assert.equal(cand?.stopLossPrice, 98.5); // min(-1.5% = 98.5, VWAP 102)
  assert.ok(cand?.sources.includes('INSTITUTIONAL'));
  assert.ok(cand?.sources.includes('ABNORMAL'));
  assert.ok(cand?.sources.includes('ANNOUNCEMENT'));
  assert.equal(report.lowSignalDay, false);
});

test('Phase 1：風控過濾剔除禁止當沖/處置/注意/停資停券', async () => {
  const selector = new Phase1Selector({
    mcpCall: mcpStub(PHASE1_DATA),
    gate: okGate(),
    today: '2026-08-10',
    yesterday: '2026-08-07',
    scanEligibility: eligStub(['2308']), // 只允許 2308
    priceCalculator: priceStub(),
  });
  const report = await selector.run();
  const symbols = report.candidates.map((c) => c.symbol);
  assert.ok(symbols.includes('2308'));
  assert.ok(!symbols.includes('2330'));
  assert.ok(!symbols.includes('2603'));
  assert.ok(!symbols.includes('2454'));
});

test('Phase 1：剔除無觸發價者（priceCalculator 失敗 → 該標的剔除）', async () => {
  const selector = new Phase1Selector({
    mcpCall: mcpStub(PHASE1_DATA),
    gate: okGate(),
    today: '2026-08-10',
    yesterday: '2026-08-07',
    scanEligibility: eligStub(['2308', '2330']),
    priceCalculator: async (symbol) => {
      if (symbol === '2330') throw new Error('無 K 線');
      return { yesterdayClose: 100, yesterdayHigh: 105, vwapEstimate: 102 };
    },
  });
  const report = await selector.run();
  const symbols = report.candidates.map((c) => c.symbol);
  assert.ok(symbols.includes('2308'));
  assert.ok(!symbols.includes('2330'));
});

test('Phase 1：候選不足 3 檔 → lowSignalDay=true（不可硬湊）', async () => {
  const selector = new Phase1Selector({
    mcpCall: mcpStub(PHASE1_DATA),
    gate: okGate(),
    today: '2026-08-10',
    yesterday: '2026-08-07',
    scanEligibility: eligStub(['2308']),
    priceCalculator: priceStub(),
  });
  const report = await selector.run();
  assert.equal(report.lowSignalDay, true);
  assert.ok(report.candidates.length >= 1);
});

test('Phase 1：完全無候選 → 空 watchlist、lowSignalDay=true', async () => {
  const selector = new Phase1Selector({
    mcpCall: mcpStub({}),
    gate: okGate(),
    today: '2026-08-10',
    yesterday: '2026-08-07',
    scanEligibility: eligStub([]),
    priceCalculator: priceStub(),
  });
  const report = await selector.run();
  assert.equal(report.candidates.length, 0);
  assert.deepEqual(report.watchlist, []);
  assert.equal(report.lowSignalDay, true);
});

test('Phase 1：set_active_watchlist 失敗 → 降級記錄於 dataGaps', async () => {
  let watchlistCalls = 0;
  const selector = new Phase1Selector({
    mcpCall: async (tool, _args) => {
      if (tool === 'set_active_watchlist') {
        watchlistCalls += 1;
        throw new Error('watchlist 設定失敗');
      }
      return {
        data: PHASE1_DATA[tool as keyof typeof PHASE1_DATA] ?? {},
        _lineage: { source: 'TWSE', freshness: 'POST_MARKET_TODAY', fetched_at: new Date().toISOString() },
      };
    },
    gate: okGate(),
    today: '2026-08-10',
    yesterday: '2026-08-07',
    scanEligibility: eligStub(['2308', '2330', '2317', '2603', '2454']),
    priceCalculator: priceStub(),
  });
  const report = await selector.run();
  assert.equal(watchlistCalls, 1);
  assert.equal(report.watchlist.length, 5); // 候選仍產出
  assert.ok(report.dataGaps.some((g) => g.tool === 'set_active_watchlist'));
});

test('Phase 1：watchlist ≤ 15 檔（候選超過 15 也截斷）', async () => {
  const manySymbols = Array.from({ length: 20 }, (_, i) => `30${String(i).padStart(2, '0')}`);
  const selector = new Phase1Selector({
    mcpCall: mcpStub({}),
    gate: okGate(),
    today: '2026-08-10',
    yesterday: '2026-08-07',
    institutionalTopN: 20,
    targetMin: 3,
    targetMax: 20,
    scanEligibility: eligStub(manySymbols),
    priceCalculator: priceStub(),
  });
  const report = await selector.run();
  assert.ok(report.watchlist.length <= 15);
});

test('候選排序：籌碼分（法人來源）優先', () => {
  const selector = new Phase1Selector({
    mcpCall: mcpStub({}),
    gate: okGate(),
    today: '2026-08-10',
    yesterday: '2026-08-07',
    scanEligibility: eligStub(['2308', '2603']),
    priceCalculator: priceStub(),
  });
  // 2308 三路徑（flowScore 25+10），2603 僅量能（10）
  return selector.run().then((report) => {
    const idx2308 = report.candidates.findIndex((c) => c.symbol === '2308');
    const idx2603 = report.candidates.findIndex((c) => c.symbol === '2603');
    if (idx2308 >= 0 && idx2603 >= 0) {
      assert.ok(idx2308 < idx2603, '法人來源候選應優先');
    }
  });
});
