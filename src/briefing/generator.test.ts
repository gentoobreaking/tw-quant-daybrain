// T019 Tactical Briefing 產生器單元測試（§9）
// 覆蓋：四種 bias 之 allowed/blocked 對應、force_flat_by 動態、JSON 檔案產出、loadBriefing 缺檔拒絕啟動、
//       事件寫入、confidence、volume_surge_threshold 注入點
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TacticalBriefingGenerator,
  actionsForBias,
  confidenceForScore,
  forceFlatByForBias,
  loadBriefing,
  type TacticalBriefing,
} from './generator.js';
import type { BiasResult } from '../bias/decision_tree.js';

const T0855 = new Date('2026-08-10T08:55:00+08:00');

function makeEnv(now: Date, opts: { failScan?: boolean } = {}) {
  const mcpCall = async (tool: string, args: Record<string, unknown>) => {
    const symbol = String(args.symbol ?? '');
    if (opts.failScan && tool === 'scan_daytrade_eligibility') {
      return { data: {}, _lineage: { source: 'UNKNOWN_SOURCE', freshness: 'POST_MARKET_TODAY', fetched_at: now.toISOString(), is_cached: false }, _chart_meta: {} };
    }
    switch (tool) {
      case 'scan_daytrade_eligibility':
        return {
          data: { symbol, can_daytrade: true, can_short_first: true, is_disposition: false, is_attention: false },
          _lineage: { source: 'TWSE_WEB', freshness: 'POST_MARKET_TODAY', fetched_at: now.toISOString(), is_cached: false },
          _chart_meta: {},
        };
      case 'get_stock_daily_kline':
        return {
          data: [{ timestamp: '2026-08-07T00:00:00+08:00', open: 1520, high: 1555, low: 1510, close: 1530 }],
          _lineage: { source: 'TWSE', freshness: 'HISTORICAL', data_date: '2026-08-07', fetched_at: now.toISOString(), is_cached: false },
          _chart_meta: {},
        };
      default:
        return { data: {}, _lineage: { source: 'TWSE', freshness: 'POST_MARKET_TODAY', fetched_at: now.toISOString(), is_cached: false }, _chart_meta: {} };
    }
  };
  const gate = (env: { _lineage: { source: string } }) =>
    env._lineage.source === 'UNKNOWN_SOURCE'
      ? { passed: false, cause: 'unknown_source', state: 'NORMAL' }
      : { passed: true, state: 'NORMAL' };
  return { mcpCall, gate };
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 't019-'));
}

function biasResult(bias: BiasResult['bias'], score: number, rationale = 'test'): BiasResult {
  return { bias, score, rationale };
}

test('actionsForBias：四種 bias 對應正確（§9.2）', () => {
  assert.deepEqual(actionsForBias('NO_TRADE'), { allowed: [], blocked: ['BUY_TO_OPEN', 'SELL_TO_OPEN'] });
  assert.deepEqual(actionsForBias('LONG_ONLY'), { allowed: ['BUY_TO_OPEN'], blocked: ['SELL_TO_OPEN'] });
  assert.deepEqual(actionsForBias('SHORT_ONLY'), { allowed: ['SELL_TO_OPEN'], blocked: ['BUY_TO_OPEN'] });
  assert.deepEqual(actionsForBias('NEUTRAL_FLEXIBLE'), { allowed: ['BUY_TO_OPEN', 'SELL_TO_OPEN'], blocked: [] });
});

test('forceFlatByForBias：SHORT_ONLY → 13:00，其餘 → 13:10（§9.2）', () => {
  assert.equal(forceFlatByForBias('SHORT_ONLY'), '13:00');
  assert.equal(forceFlatByForBias('LONG_ONLY'), '13:10');
  assert.equal(forceFlatByForBias('NEUTRAL_FLEXIBLE'), '13:10');
  assert.equal(forceFlatByForBias('NO_TRADE'), '13:10');
});

test('confidenceForScore：|70| HIGH、|50| MEDIUM、其餘 LOW', () => {
  assert.equal(confidenceForScore(70), 'HIGH');
  assert.equal(confidenceForScore(-70), 'HIGH');
  assert.equal(confidenceForScore(50), 'MEDIUM');
  assert.equal(confidenceForScore(-50), 'MEDIUM');
  assert.equal(confidenceForScore(49), 'LOW');
});

test('generate：LONG_ONLY 完整結構 + 檔案產出 + 事件', async () => {
  const dir = await tmpDir();
  const { mcpCall, gate } = makeEnv(T0855);
  const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
  const eventLogger = {
    write: (type: string, fields: Record<string, unknown>, _now?: Date) => { events.push({ type, fields }); },
  } as never;
  const gen = new TacticalBriefingGenerator({ mcpCall, gate, events: eventLogger, outputDir: dir, nowFn: () => T0855 });
  const { briefing, filePath } = await gen.generate('2308', biasResult('LONG_ONLY', 75, '趨勢多頭 | 法人買超 | 夜盤平 | 試撮無資料'), { symbol: '2308', name: '台達電', yesterdayClose: 1530 }, T0855);

  // 結構
  assert.equal(briefing.bias_assessment.bias, 'LONG_ONLY');
  assert.equal(briefing.bias_assessment.score, 75);
  assert.equal(briefing.bias_assessment.confidence, 'HIGH');
  assert.deepEqual(briefing.trading_plan.allowed_actions, ['BUY_TO_OPEN']);
  assert.deepEqual(briefing.trading_plan.blocked_actions, ['SELL_TO_OPEN']);
  assert.equal(briefing.trading_plan.active_window.force_flat_by, '13:10');
  assert.equal(briefing.trading_plan.active_window.start_time, '09:05');
  assert.equal(briefing.trading_plan.active_window.no_new_entry_after, '11:30');
  assert.equal(briefing.trading_plan.key_levels.volume_surge_threshold, 2.5);
  assert.equal(briefing.trading_plan.key_levels.breakout_pivot_price, 1555); // 昨日高
  assert.equal(briefing.risk_guardrails.hard_stop_loss_pct, 1.5);
  assert.equal(briefing.risk_guardrails.take_profit_target_1_pct, 2.0);
  assert.equal(briefing.risk_guardrails.max_drawdown_limit_ntd, 30000);
  assert.ok(briefing.risk_guardrails.safety_flags.can_daytrade);
  assert.ok(briefing.risk_guardrails.safety_flags.can_short_first);
  assert.equal(briefing.risk_guardrails.safety_flags.is_disposition, false);
  assert.equal(briefing._lineage.generated_at, '2026-08-10T08:55:00+08:00');
  assert.equal(briefing._lineage.agent_version, 'tw-quant-daybrain/v2.0.0');
  assert.equal(briefing._lineage.data_sources.length, 2); // TWSE_WEB + TWSE

  // 檔案存在 + 內容可反序列化
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as TacticalBriefing;
  assert.equal(parsed.target.symbol, '2308');
  assert.equal(path.basename(filePath), '2026-08-10_2308.json');

  // 事件
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'briefing_generated');
  assert.equal(events[0].fields.briefing_id, '2026-08-10_2308');
  assert.equal(events[0].fields.symbol, '2308');
});

test('generate：四種 bias 各自 allowed/blocked + force_flat_by', async () => {
  const dir = await tmpDir();
  const { mcpCall, gate } = makeEnv(T0855);
  const gen = new TacticalBriefingGenerator({ mcpCall, gate, outputDir: dir, nowFn: () => T0855 });
  const cases: Array<[BiasResult['bias'], number, string[]]> = [
    ['LONG_ONLY', 75, ['BUY_TO_OPEN']],
    ['SHORT_ONLY', -75, ['SELL_TO_OPEN']],
    ['NEUTRAL_FLEXIBLE', 30, ['BUY_TO_OPEN', 'SELL_TO_OPEN']],
    ['NO_TRADE', 0, []],
  ];
  for (const [bias, score, allowed] of cases) {
    const { briefing } = await gen.generate('2308', biasResult(bias, score), { symbol: '2308', yesterdayClose: 1530 }, T0855);
    assert.deepEqual(briefing.trading_plan.allowed_actions, allowed, `bias=${bias}`);
    assert.equal(briefing.trading_plan.active_window.force_flat_by, bias === 'SHORT_ONLY' ? '13:00' : '13:10');
  }
});

test('generate：資格掃描失敗 → 保守降級 can_daytrade=false + UNKNOWN source', async () => {
  const dir = await tmpDir();
  const { mcpCall, gate } = makeEnv(T0855, { failScan: true });
  const gen = new TacticalBriefingGenerator({ mcpCall, gate, outputDir: dir, nowFn: () => T0855 });
  const { briefing } = await gen.generate('2308', biasResult('LONG_ONLY', 75), { symbol: '2308', yesterdayClose: 1530 }, T0855);
  assert.equal(briefing.risk_guardrails.safety_flags.can_daytrade, false);
  assert.equal(briefing._lineage.data_sources[0].source, 'UNKNOWN');
});

test('generate：NEUTRAL_FLEXIBLE 日 → allowed 雙向（T016 門檻 85 由 T009 白名單接手）', async () => {
  const dir = await tmpDir();
  const { mcpCall, gate } = makeEnv(T0855);
  const gen = new TacticalBriefingGenerator({ mcpCall, gate, outputDir: dir, nowFn: () => T0855 });
  const { briefing } = await gen.generate('2308', biasResult('NEUTRAL_FLEXIBLE', 30), { symbol: '2308', yesterdayClose: 1530 }, T0855);
  assert.deepEqual(briefing.trading_plan.allowed_actions, ['BUY_TO_OPEN', 'SELL_TO_OPEN']);
  assert.equal(briefing.trading_plan.key_levels.volume_surge_threshold, 2.5);
});

test('loadBriefing：找到當日檔 → 回 briefing；找不到 → null（§9.3 拒絕啟動）', async () => {
  const dir = await tmpDir();
  const { mcpCall, gate } = makeEnv(T0855);
  const gen = new TacticalBriefingGenerator({ mcpCall, gate, outputDir: dir, nowFn: () => T0855 });
  await gen.generate('2308', biasResult('LONG_ONLY', 75), { symbol: '2308', yesterdayClose: 1530 }, T0855);

  const found = await loadBriefing(dir, '2308', T0855);
  assert.ok(found);
  assert.equal(found!.target.symbol, '2308');
  assert.equal(found!.bias_assessment.bias, 'LONG_ONLY');

  const missing = await loadBriefing(dir, '9999', T0855);
  assert.equal(missing, null);
});

test('generate：scoring_breakdown 總分與 bias score 一致', async () => {
  const dir = await tmpDir();
  const { mcpCall, gate } = makeEnv(T0855);
  const gen = new TacticalBriefingGenerator({ mcpCall, gate, outputDir: dir, nowFn: () => T0855 });
  const { briefing } = await gen.generate('2308', biasResult('LONG_ONLY', 75, '趨勢多頭 | 法人買超 | 夜盤平 | 試撮無資料'), { symbol: '2308', yesterdayClose: 1530 }, T0855);
  const total = briefing.bias_assessment.scoring_breakdown.reduce((a, b) => a + b.score, 0);
  assert.equal(total, 75);
  assert.equal(briefing.bias_assessment.scoring_breakdown.length, 4);
});
