// 交易日誌與績效指標（T010，§14.4 JournalEntry + §15 績效指標）
// - 以 T004 事件日誌為唯一統計來源（§14.4）；統計數字不得由 LLM 或人工填寫
// - 指標定義：勝率 / 盈虧比 / 期望值 / 最大回撤 / 訊號轉換率 / 假突破率 /
//   引擎攔截統計 / WFE（§15，回測由 T023 提供，此處預留欄位）
// - PnL 計算含手續費與交易稅（§12.4 假設：手續費 0.1425%×0.28 折、當沖證交稅 0.0015）
// - 週滾動統計：連續 2 週 PF < 1.1 或 Hit Rate < 35% → 策略暫停警示事件

import type { DayBrainEvent } from '../logging/event_types.js';

/** 交易成本假設（§12.4） */
export interface CostModel {
  /** 手續費率（預設 0.1425%） */
  commissionRate: number;
  /** 手續費折數（預設 0.28 折 = 0.28） */
  commissionDiscount: number;
  /** 當沖證交稅率（預設 0.0015） */
  taxRate: number;
  /** 最低手續費（預設 20 元） */
  minCommission: number;
}

export const DEFAULT_COST_MODEL: CostModel = {
  commissionRate: 0.001425,
  commissionDiscount: 0.28,
  taxRate: 0.0015,
  minCommission: 20,
};

/** 引擎攔截統計（§15，v2.0：blocked_by_briefing_bias 等） */
export interface BlockedStats {
  blocked_by_briefing_bias: number;
  blocked_by_sector_limit: number;
  blocked_by_margin_cap: number;
  priority_ranking_conflicts_resolved: number;
}

/** §14.4 JournalEntry.summary */
export interface JournalSummary {
  signals_issued: number;
  signals_triggered: number;
  trades_executed: number;
  wins: number;
  losses: number;
  gross_pnl: number;
  net_pnl: number;
  hit_rate: number;
  avg_win: number;
  avg_loss: number;
  profit_factor: number;
  max_drawdown_pct: number;
  slippage_avg_pct: number;
  /** 訊號轉換率（§15：觸發 ÷ 訊號） */
  signal_conversion_rate: number;
  /** 假突破率（§15：failed_breakout ÷ 確認訊號數） */
  failed_breakout_rate: number;
  /** 期望值（§15：平均每筆盈虧） */
  expectancy: number;
  /** 引擎攔截統計（v2.0） */
  blocked: BlockedStats;
}

/** §14.4 JournalEntry */
export interface JournalEntry {
  date: string;
  scoring_version: string;
  summary: JournalSummary;
  events: Array<Pick<DayBrainEvent, 'ts' | 'type' | 'signal_id' | 'position_id' | 'symbol' | 'reason' | 'cause'>>;
  /** LLM 檢討報告（T011 寫入；未生成為 null） */
  llm_report: string | null;
}

/** 週滾動統計（§15） */
export interface WeeklyStats {
  week_start: string;
  week_end: string;
  profit_factor: number;
  hit_rate: number;
  trades: number;
  /** 連續 2 週 PF < 1.1 或 Hit Rate < 35% → true */
  pause_recommended: boolean;
}

/** 一筆已實現交易（由 position_opened/closed 配對） */
export interface TradeRecord {
  position_id: string;
  signal_id: string | undefined;
  symbol: string;
  action: 'BUY_TO_OPEN' | 'SELL_TO_OPEN';
  opened_ts: string;
  closed_ts: string;
  reason: ExitReasonLike;
  pnl: number;
}

type ExitReasonLike = string;

/** 訊號轉換率分母：確認（雙 tick 後）之訊號數 */
function confirmedSignals(events: DayBrainEvent[]): number {
  return events.filter((e) => e.type === 'signal_triggered' || e.type === 'position_opened').length;
}

/**
 * 由事件序列計算 PnL 配對（position_opened ↔ position_closed）。
 * position_closed 的 pnl 來自 extra.pnlNtd（T008 close() 寫入之每日風控數值）。
 * 若事件無 pnl 欄位（舊資料），以 0 計並以 cost 模型補手續費/稅。
 */
export function pairTrades(events: DayBrainEvent[]): TradeRecord[] {
  const trades: TradeRecord[] = [];
  const opened = new Map<string, DayBrainEvent>();
  for (const e of events) {
    if (e.type === 'position_opened' && e.position_id) {
      opened.set(e.position_id, e);
    } else if (e.type === 'position_closed' && e.position_id) {
      const open = opened.get(e.position_id);
      if (!open) continue; // 無配對（缺欄位 → 不靜默填補，跳過並由呼叫端警示）
      trades.push({
        position_id: e.position_id,
        signal_id: (open.signal_id as string | undefined) ?? (e.signal_id as string | undefined),
        symbol: (open.symbol as string) ?? (e.symbol as string) ?? '?',
        action: (open.action as 'BUY_TO_OPEN' | 'SELL_TO_OPEN') ?? 'BUY_TO_OPEN',
        opened_ts: open.ts,
        closed_ts: e.ts,
        reason: (e.reason as string) ?? 'UNKNOWN',
        pnl: typeof e.pnlNtd === 'number' ? e.pnlNtd : 0,
      });
      opened.delete(e.position_id);
    }
  }
  return trades;
}

/** 手續費 + 交易稅（§12.4：買賣雙邊手續費 + 賣出當沖證交稅） */
export function tradingCost(notional: number, cost: CostModel = DEFAULT_COST_MODEL): number {
  const commission = Math.max(notional * cost.commissionRate * cost.commissionDiscount, cost.minCommission);
  const tax = notional * cost.taxRate; // 當沖賣出
  return commission * 2 + tax;
}

/**
 * 計算日指標（§14.4 summary）。
 * @param date 交易日 YYYY-MM-DD
 * @param scoringVersion 當日 scoring_version（§14.4；未知時回傳 'unknown'）
 * @param events 當日事件（T004 loadDay 回傳）
 * @param opts 成本模型與滑價（slippage_avg_pct 由 T010 滑價計算模組填入；此處可傳入）
 */
export function computeJournalEntry(
  date: string,
  scoringVersion: string,
  events: DayBrainEvent[],
  opts: { cost?: CostModel; slippageAvgPct?: number } = {},
): JournalEntry {
  const cost = opts.cost ?? DEFAULT_COST_MODEL;

  const signalsIssued = events.filter((e) => e.type === 'signal_issued').length;
  const signalsTriggered = events.filter((e) => e.type === 'signal_triggered').length;
  const trades = pairTrades(events);
  const tradesExecuted = trades.length;

  // PnL（gross：不含成本；net：含手續費+稅）
  const gross = trades.reduce((s, t) => s + t.pnl, 0);
  // 淨損益：以成交名目金額估算成本。事件未帶金額時以 pnl 名目近似（保守以 |pnl| 計費）
  const costs = trades.reduce((s, t) => s + tradingCost(Math.abs(t.pnl) || 100_000, cost), 0);
  const net = gross - costs;

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const hitRate = tradesExecuted > 0 ? wins / tradesExecuted : 0;
  const avgWin = wins > 0 ? trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const avgLoss = losses > 0 ? trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0) / losses : 0;
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // 最大回撤（日損益累積之最低點，§15）：以逐筆累積淨損益之峰值回撤
  let peak = 0;
  let maxDd = 0;
  let cum = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = peak > 0 ? (peak - cum) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const failedBreakouts = events.filter((e) => e.type === 'failed_breakout').length;
  const confirmed = confirmedSignals(events);
  const failedBreakoutRate = confirmed > 0 ? failedBreakouts / confirmed : 0;
  const conversionRate = signalsIssued > 0 ? signalsTriggered / signalsIssued : 0;
  const expectancy = tradesExecuted > 0 ? net / tradesExecuted : 0;

  // 引擎攔截統計（§15，v2.0；事件欄位由 T009/T020 寫入）
  const blocked = {
    blocked_by_briefing_bias: events.filter((e) => e.type === 'signal_issued' && e.blocked_by_briefing_bias === true).length,
    blocked_by_sector_limit: events.filter((e) => e.type === 'signal_issued' && e.blocked_by_sector_limit === true).length,
    blocked_by_margin_cap: events.filter((e) => e.type === 'signal_issued' && e.blocked_by_margin_cap === true).length,
    priority_ranking_conflicts_resolved: events.filter((e) => e.type === 'priority_ranked' && e.conflicts_resolved === true).length,
  };

  return {
    date,
    scoring_version: scoringVersion,
    summary: {
      signals_issued: signalsIssued,
      signals_triggered: signalsTriggered,
      trades_executed: tradesExecuted,
      wins,
      losses,
      gross_pnl: Math.round(gross),
      net_pnl: Math.round(net),
      hit_rate: Math.round(hitRate * 100) / 100,
      avg_win: Math.round(avgWin),
      avg_loss: Math.round(avgLoss),
      profit_factor: Math.round(profitFactor * 100) / 100,
      max_drawdown_pct: Math.round(maxDd * 1000) / 10,
      slippage_avg_pct: opts.slippageAvgPct ?? 0,
      signal_conversion_rate: Math.round(conversionRate * 100) / 100,
      failed_breakout_rate: Math.round(failedBreakoutRate * 100) / 100,
      expectancy: Math.round(expectancy),
      blocked,
    },
    events: events.map((e) => ({
      ts: e.ts,
      type: e.type,
      signal_id: e.signal_id,
      position_id: e.position_id,
      symbol: e.symbol,
      reason: e.reason as string | undefined,
      cause: e.cause as string | undefined,
    })),
    llm_report: null,
  };
}

/** 週滾動統計：連續 2 週 PF < 1.1 或 Hit Rate < 35% → 策略暫停警示（§15） */
export function computeWeeklyStats(days: JournalEntry[]): WeeklyStats[] {
  const byWeek = new Map<string, JournalEntry[]>();
  for (const d of days) {
    const dt = new Date(`${d.date}T00:00:00+08:00`);
    const dow = (dt.getDay() + 6) % 7; // 週一 = 0
    const monday = new Date(dt);
    monday.setDate(dt.getDate() - dow);
    const key = monday.toISOString().slice(0, 10);
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key)!.push(d);
  }

  const out: WeeklyStats[] = [];
  let prevPause = false;
  for (const [weekStart, entries] of [...byWeek.entries()].sort()) {
    const trades = entries.reduce((s, d) => s + d.summary.trades_executed, 0);
    const wins = entries.reduce((s, d) => s + d.summary.wins, 0);
    const grossProfit = entries.reduce((s, d) => s + Math.max(d.summary.gross_pnl, 0), 0);
    const grossLoss = entries.reduce((s, d) => s + Math.abs(Math.min(d.summary.gross_pnl, 0)), 0);
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const hitRate = trades > 0 ? wins / trades : 0;

    // 本週觸發暫停（PF<1.1 或 HR<35%）；連續 2 週 → pause_recommended
    const thisWeekPause = trades > 0 && (pf < 1.1 || hitRate < 0.35);
    const pause = prevPause && thisWeekPause;

    const weekEnd = new Date(`${weekStart}T00:00:00+08:00`);
    weekEnd.setDate(weekEnd.getDate() + 6);
    out.push({
      week_start: weekStart,
      week_end: weekEnd.toISOString().slice(0, 10),
      profit_factor: Math.round(pf * 100) / 100,
      hit_rate: Math.round(hitRate * 100) / 100,
      trades,
      pause_recommended: pause,
    });
    prevPause = thisWeekPause;
  }
  return out;
}

/** 產出策略暫停警示事件（§15；由呼叫端寫入事件日誌） */
export function pauseAlertEvents(stats: WeeklyStats[]): Array<{ type: 'strategy_pause_alert'; reason: string; week: string }> {
  return stats
    .filter((s) => s.pause_recommended)
    .map((s) => ({
      type: 'strategy_pause_alert' as const,
      reason: `連續 2 週 PF<1.1 或 Hit Rate<35%（PF=${s.profit_factor}, HR=${s.hit_rate * 100}%）`,
      week: s.week_start,
    }));
}

/** 滑價計算：以盤後/即時 K 線回推實際成交價，比對建議價（§15 slippage_avg_pct） */
export function computeSlippage(
  signals: Array<{ signal_id: string; suggested_price: number; actual_price: number }>,
): number {
  if (signals.length === 0) return 0;
  const pcts = signals.map((s) => ((s.actual_price - s.suggested_price) / s.suggested_price) * 100);
  return Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) / 100;
}
