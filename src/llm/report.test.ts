// T011 LLM 檢討報告與防幻覺 測試
// 驗收：Schema 驗證拒收、白名單過濾、llm_offline fallback、bias_locked 納入

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LlmReportGenerator,
  LLMReportSchema,
  filterSymbols,
  templateNarrative,
  attachReport,
  type LlmClient,
} from './report.js';
import type { JournalEntry } from '../metrics/journal.js';
import type { DayBrainEvent } from '../logging/event_types.js';

/** 測試用 JournalEntry（T010 產出形態） */
function journal(): JournalEntry {
  return {
    date: '2026-08-10',
    scoring_version: '2.1.0',
    summary: {
      signals_issued: 4,
      signals_triggered: 3,
      trades_executed: 2,
      wins: 1,
      losses: 1,
      gross_pnl: 12450,
      net_pnl: 11050,
      hit_rate: 0.5,
      avg_win: 23600,
      avg_loss: -12550,
      profit_factor: 1.88,
      max_drawdown_pct: -1.2,
      slippage_avg_pct: -0.08,
      signal_conversion_rate: 0.75,
      failed_breakout_rate: 0.33,
      expectancy: 5525,
      blocked: { blocked_by_briefing_bias: 1, blocked_by_sector_limit: 0, blocked_by_margin_cap: 0, priority_ranking_conflicts_resolved: 1 },
    },
    events: [
      { ts: '2026-08-10T09:45:12+08:00', type: 'signal_issued', signal_id: 's1', symbol: '2308', reason: undefined, cause: undefined },
    ],
    llm_report: null,
  };
}

function events(): DayBrainEvent[] {
  return [
    { ts: '2026-08-10T08:30:00+08:00', type: 'bias_locked', version: 1, seq: 1, bias: 'LONG', score: 62 },
  ] as unknown as DayBrainEvent[];
}

// ===== Schema 驗證（§16.2） =====

test('Schema：合法報告通過驗證', () => {
  const r = {
    report_id: '2026-08-10-R1',
    generated_at: '2026-08-10T14:35:00+08:00',
    narrative: '當日訊號品質佳。',
    stats: { trades: 2, wins: 1, losses: 1, hit_rate: 0.5, profit_factor: 1.88, net_pnl: 11050, max_drawdown_pct: -1.2, signals_issued: 4 },
    bias: { bias: 'LONG' as const, score: 62 },
    llm_offline: false,
    disclaimer: '僅供研究參考，不構成投資建議' as const,
  };
  const parsed = LLMReportSchema.safeParse(r);
  assert.equal(parsed.success, true);
});

test('Schema：拒收非法（hit_rate 超範圍、disclaimer 不符、stats 缺欄）', () => {
  const base = {
    report_id: 'x',
    generated_at: 't',
    narrative: 'n',
    stats: { trades: 2, wins: 1, losses: 1, hit_rate: 1.5, profit_factor: 1, net_pnl: 0, max_drawdown_pct: 0, signals_issued: 1 },
    bias: null,
    llm_offline: false,
    disclaimer: '僅供研究參考，不構成投資建議' as const,
  };
  assert.equal(LLMReportSchema.safeParse(base).success, false); // hit_rate > 1
  assert.equal(
    LLMReportSchema.safeParse({ ...base, disclaimer: '穩賺不賠' }).success,
    false, // 免責聲明必須固定
  );
  const noStats = { ...base };
  delete (noStats as Record<string, unknown>).stats;
  assert.equal(LLMReportSchema.safeParse(noStats).success, false); // 缺 stats
});

// ===== llm_offline fallback（§18.3） =====

test('無 LLM Client → llm_offline 模板報告', async () => {
  const gen = new LlmReportGenerator();
  const r = await gen.generate(journal(), events());
  assert.equal(r.llm_offline, true);
  assert.match(r.narrative, /僅供研究參考，不構成投資建議/);
  assert.match(r.narrative, /勝率 50\.0%/); // 統計數字由模板注入
  assert.equal(r.stats.trades, 2);
  assert.equal(r.bias?.bias, 'LONG');
});

test('LLM 失敗（拋錯/逾時）→ llm_offline fallback', async () => {
  const failing: LlmClient = {
    generate: async () => {
      throw new Error('API 斷線');
    },
  };
  const gen = new LlmReportGenerator({ llm: failing });
  const r = await gen.generate(journal(), events());
  assert.equal(r.llm_offline, true);
  assert.match(r.narrative, /僅供研究參考/);
});

// ===== LLM 正常路徑 + 硬數字注入（§16.1/§16.4） =====

test('LLM 正常：敘事採用 LLM 輸出、統計數字仍由規則引擎注入', async () => {
  const llm: LlmClient = {
    generate: async (prompt) => {
      assert.match(prompt, /不得自行推算/);
      return '今日 2308 突破量能充足，執行良好。';
    },
  };
  const gen = new LlmReportGenerator({
    llm,
    symbolList: async () => ['2308'],
  });
  const r = await gen.generate(journal(), events());
  assert.equal(r.llm_offline, false);
  assert.match(r.narrative, /2308/);
  // 統計欄位與 template 無關，直接來自 summary
  assert.equal(r.stats.hit_rate, 0.5);
  assert.equal(r.stats.profit_factor, 1.88);
});

// ===== Symbol 白名單（§16.3） =====

test('白名單：非白名單 symbol 段落被捨棄', async () => {
  const llm: LlmClient = {
    generate: async () => '看好 2330 表現。\n\n另外 9999 也有機會。\n\n2308 突破成功。',
  };
  const gen = new LlmReportGenerator({
    llm,
    symbolList: async () => ['2308', '2330'], // 9999 不在白名單
  });
  const r = await gen.generate(journal(), events());
  assert.match(r.narrative, /2330/);
  assert.match(r.narrative, /2308/);
  assert.doesNotMatch(r.narrative, /9999/);
});

test('白名單：全部段落被捨棄 → 模板 fallback', async () => {
  const llm: LlmClient = {
    generate: async () => '只有 7777 值得關注。',
  };
  const gen = new LlmReportGenerator({
    llm,
    symbolList: async () => ['2308'],
  });
  const r = await gen.generate(journal(), events());
  assert.doesNotMatch(r.narrative, /7777/);
  assert.match(r.narrative, /僅供研究參考/); // fallback 模板
});

test('filterSymbols：純函式單元', () => {
  const wl = new Set(['2308']);
  assert.equal(filterSymbols('2308 好', wl), '2308 好');
  assert.equal(filterSymbols('9999 不好', wl), '');
  assert.equal(filterSymbols('無代碼段落', wl), '無代碼段落');
});

// ===== bias_locked 納入（v2.0） =====

test('bias_locked 事件 → 報告 bias 欄位', async () => {
  const gen = new LlmReportGenerator();
  const r = await gen.generate(journal(), events());
  assert.deepEqual(r.bias, { bias: 'LONG', score: 62 });
});

test('無 bias_locked 事件 → bias null', async () => {
  const gen = new LlmReportGenerator();
  const r = await gen.generate(journal(), []);
  assert.equal(r.bias, null);
});

// ===== attachReport（T010 寫入介面） =====

test('attachReport：寫入 JournalEntry.llm_report', async () => {
  const gen = new LlmReportGenerator();
  const r = await gen.generate(journal(), events());
  const updated = attachReport(journal(), r);
  assert.equal(updated.llm_report, r.narrative);
  assert.equal(updated.summary.trades_executed, 2); // 不影響統計
});

// ===== templateNarrative =====

test('templateNarrative：無交易日說明', () => {
  const j = journal();
  j.summary.trades_executed = 0;
  const t = templateNarrative(j.summary, 'NEUTRAL');
  assert.match(t, /今日無交易/);
});
