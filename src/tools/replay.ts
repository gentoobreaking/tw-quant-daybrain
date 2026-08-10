// 回放工具與滑價驗證（T012，§1 原則 5「所有決策可回放」）
// - 以事件日誌（T004）重演單日決策：訊號→觸發→進場→出場時間軸
// - 決策追溯：每筆 signal_issued 可展開輸入（VWAP/surge/分數 breakdown/
//   data_quality、Bias 攔截、Priority rank）與守門結果
// - 重演不呼叫 MCP：純讀取事件日誌與必要 _chart_meta 快照，離線可用
// - 滑價驗證模式：讀取 T010 滑價結果，標註異常滑價（> 0.3%）之訊號
// - 輸出支援 JSON（自動化比對）與人類可讀摘要
// - v2.0：bias_locked / briefing_generated / priority_ranked 事件納入時間軸

import { EventLogger } from '../logging/event_logger.js';

/** 回放時間軸項目（依 ts+seq 排序） */
export interface TimelineItem {
  ts: string;
  seq: number;
  type: string;
  detail: Record<string, unknown>;
}

/** 單筆訊號決策追溯 */
export interface SignalTrace {
  signal_id: string;
  ts: string;
  symbol: string;
  score?: number;
  grade?: string;
  /** 當時輸入快照（VWAP/surge 等；來自事件欄位或 _chart_meta 快照） */
  inputs?: Record<string, unknown>;
  /** 分數 breakdown（T007 score_breakdown） */
  breakdown?: Record<string, unknown>;
  data_quality?: Record<string, unknown>;
  /** Bias 白名單攔截（blocked_by_briefing_bias） */
  blocked_by_briefing_bias?: boolean;
  /** Priority rank（priority_ranked 事件） */
  priority_rank?: number;
  /** 守門結果（freshness_gate_pass/fail） */
  gate?: { passed: boolean; cause?: string };
}

/** 滑價驗證結果 */
export interface SlippageCheck {
  signal_id: string;
  symbol: string;
  suggested_price?: number;
  actual_price?: number;
  slippage_pct?: number;
  /** 異常滑價（> 0.3% 絕對值） */
  abnormal: boolean;
}

export interface ReplayResult {
  date: string;
  /** 事件日誌缺欄位警示（不靜默填補） */
  warnings: string[];
  timeline: TimelineItem[];
  signals: SignalTrace[];
  slippage: SlippageCheck[];
  /** 事件日誌檔路徑（供稽核） */
  source: string;
}

const TRACEABLE = new Set([
  'signal_issued',
  'signal_triggered',
  'signal_expired',
  'failed_breakout',
  'position_opened',
  'position_closed',
  'bias_locked',
  'briefing_generated',
  'priority_ranked',
  'freshness_gate_pass',
  'freshness_gate_fail',
  'daily_lockout',
  'phase_start',
  'phase_end',
]);
void TRACEABLE;

/** 異常滑價門檻（> 0.3%，T012 驗收） */
export const ABNORMAL_SLIPPAGE_PCT = 0.3;

/**
 * 重演單日決策。
 * @param logger EventLogger（T004）
 * @param date 交易日 YYYY-MM-DD
 */
export function replayDay(logger: EventLogger, date: string): ReplayResult {
  const events = logger.loadDay(date, { silent: true });
  const warnings: string[] = [];

  // 時間軸（依 ts+seq 排序；§14.4 回放排序）
  const timeline: TimelineItem[] = events.map((e) => {
    const { ts, seq, type, ...rest } = e as unknown as Record<string, unknown>;
    const detail = { ...rest };
    delete detail.version;
    return { ts: String(ts), seq: Number(seq), type: String(type), detail };
  });
  timeline.sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1));

  // 訊號追溯（兩段式：先收集 signal_issued，再套用 gate/priority 對應）
  const signals = new Map<string, SignalTrace>();
  for (const e of events) {
    if (e.type === 'signal_issued') {
      const sid = e.signal_id;
      if (!sid) {
        warnings.push(`signal_issued 缺 signal_id（ts=${e.ts}）`);
        continue;
      }
      const trace: SignalTrace = {
        signal_id: sid,
        ts: e.ts,
        symbol: String(e.symbol ?? '?'),
        score: typeof e.score === 'number' ? e.score : undefined,
        grade: typeof e.grade === 'string' ? e.grade : undefined,
        inputs: e.inputs as Record<string, unknown> | undefined,
        breakdown: e.score_breakdown as Record<string, unknown> | undefined,
        data_quality: e.data_quality as Record<string, unknown> | undefined,
        blocked_by_briefing_bias: e.blocked_by_briefing_bias === true,
      };
      signals.set(sid, trace);
    }
  }
  // 第二段：gate / priority 事件（其 ts 可能早於或晚於 signal_issued）
  for (const e of events) {
    if (e.type === 'freshness_gate_pass' && e.signal_id) {
      const t = signals.get(String(e.signal_id));
      if (t) t.gate = { passed: true };
    } else if (e.type === 'freshness_gate_fail' && e.signal_id) {
      const t = signals.get(String(e.signal_id));
      if (t) t.gate = { passed: false, cause: typeof e.cause === 'string' ? e.cause : 'unknown' };
    } else if (e.type === 'priority_ranked' && Array.isArray(e.candidates)) {
      // candidates: [{signal_id, symbol, score, rank?}]
      const cands = e.candidates as Array<Record<string, unknown>>;
      cands.forEach((c, idx) => {
        const sid = String(c.signal_id ?? '');
        const t = signals.get(sid);
        if (t) t.priority_rank = typeof c.rank === 'number' ? Number(c.rank) : idx + 1;
      });
    }
  }

  // 滑價驗證（T010 slippage_avg_pct 結果；事件帶 actual_price/suggested_price 時計算）
  const slippage: SlippageCheck[] = [];
  for (const [sid, t] of signals) {
    const sigEvent = events.find((e) => e.type === 'signal_issued' && e.signal_id === sid);
    const suggested = t.inputs?.suggested_price ?? sigEvent?.suggested_price;
    const actual = sigEvent?.actual_price ?? t.inputs?.actual_price;
    if (typeof suggested === 'number' && typeof actual === 'number' && suggested !== 0) {
      const pct = ((actual - suggested) / suggested) * 100;
      slippage.push({
        signal_id: sid,
        symbol: t.symbol,
        suggested_price: suggested,
        actual_price: actual,
        slippage_pct: Math.round(pct * 100) / 100,
        abnormal: Math.abs(pct) > ABNORMAL_SLIPPAGE_PCT,
      });
    } else {
      // 缺滑價資料 → 警示（不靜默填補）
      warnings.push(`signal ${sid}（${t.symbol}）缺滑價比對資料（suggested/actual price）`);
    }
  }

  return {
    date,
    warnings,
    timeline,
    signals: [...signals.values()],
    slippage,
    source: (logger as unknown as { fileForDate(d: string): string }).fileForDate(date),
  };
}

/** JSON 輸出（供自動化比對） */
export function toJson(result: ReplayResult): string {
  return JSON.stringify(result, null, 2);
}

/** 人類可讀摘要 */
export function toSummaryText(result: ReplayResult): string {
  const lines: string[] = [];
  lines.push(`===== 回放：${result.date} =====`);
  lines.push(`事件 ${result.timeline.length} 筆、訊號 ${result.signals.length} 筆、滑價檢查 ${result.slippage.length} 筆`);
  if (result.warnings.length > 0) {
    lines.push('⚠ 警示（缺欄位，不靜默填補）：');
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  lines.push('--- 時間軸 ---');
  for (const item of result.timeline) {
    const brief = briefDetail(item.type, item.detail);
    lines.push(`  ${item.ts} [${item.type}] ${brief}`);
  }
  lines.push('--- 訊號追溯 ---');
  for (const s of result.signals) {
    lines.push(
      `  ${s.signal_id} ${s.symbol} score=${s.score ?? 'n/a'} ${s.grade ?? ''}` +
        `${s.blocked_by_briefing_bias ? ' [Bias 攔截]' : ''}` +
        `${s.priority_rank !== undefined ? ` rank#${s.priority_rank}` : ''}` +
        `${s.gate ? ` gate=${s.gate.passed ? 'pass' : `FAIL:${s.gate.cause}`}` : ''}`,
    );
  }
  lines.push('--- 滑價驗證（異常 > ±0.3%） ---');
  for (const s of result.slippage) {
    lines.push(`  ${s.signal_id} ${s.symbol} ${s.suggested_price}→${s.actual_price} (${s.slippage_pct}%)${s.abnormal ? ' ⚠異常' : ''}`);
  }
  return lines.join('\n');
}

/** 時間軸項目摘要（人類可讀） */
function briefDetail(type: string, detail: Record<string, unknown>): string {
  switch (type) {
    case 'signal_issued':
      return `symbol=${detail.symbol} score=${detail.score}`;
    case 'signal_triggered':
      return `signal=${detail.signal_id}`;
    case 'position_opened':
      return `${detail.symbol} ${detail.action ?? ''} ${detail.entry_price ?? ''}`;
    case 'position_closed':
      return `${detail.position_id} ${detail.reason}`;
    case 'failed_breakout':
      return `${detail.symbol} ${detail.signal_id}`;
    case 'bias_locked':
      return `${detail.bias} score=${detail.score}`;
    case 'briefing_generated':
      return `briefing=${detail.briefing_id}`;
    case 'priority_ranked':
      return `candidates=${Array.isArray(detail.candidates) ? (detail.candidates as unknown[]).length : '?'}`;
    case 'freshness_gate_fail':
      return `cause=${detail.cause}`;
    case 'phase_end':
      return `phase=${detail.phase} trigger=${detail.trigger ?? '-'}`;
    case 'daily_lockout':
      return String(detail.reason ?? '');
    default:
      return '';
  }
}

/** CLI 入口（replay --date YYYY-MM-DD [--json]） */
export function replayCli(args: string[]): number {
  const dateIdx = args.indexOf('--date');
  const date = dateIdx >= 0 ? args[dateIdx + 1] : undefined;
  const json = args.includes('--json');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('用法: replay --date YYYY-MM-DD [--json]');
    return 2;
  }
  try {
    const logger = new EventLogger(process.env.LOG_DIR ?? './logs');
    const result = replayDay(logger, date);
    if (json) {
      process.stdout.write(toJson(result));
    } else {
      process.stdout.write(toSummaryText(result) + '\n');
    }
    return 0;
  } catch (err) {
    console.error(`回放失敗: ${(err as Error).message}`);
    return 1;
  }
}
