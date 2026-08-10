// BULL_TRAP_VWAP_SHORT 空方策略引擎（T018，§7）
// - 適用：假突破跌破 VWAP（先賣後買）；空方風控嚴於多頭（防軋空/漲停鎖死無法平倉）
// - 資格掃描（§7.1）：can_short_first == true、margin_short_available == true、is_disposition == false
// - 進場四條件（§7.2）：時間窗 09:15–11:30；頂部爆量拉回（detect_volume_surge → BEARISH_BREAKDOWN）；
//   連續 2 根 1 分 K 收 VWAP 下方；跌破盤前 15 分低點；台指期黑棒開高走低
// - 評分（§7.3）：四條件各 +25；今日已漲 ≥6.5% Veto -100（嚴禁空在接近漲停）
// - 停損（§7.4，任一即刻 SELL_TO_COVER）：+1.5% 硬停損；站回 VWAP 超 1 分鐘；突破當日高點
// - 停利（§7.4）：-2.0% 回補 50%；剩餘 50% 移動停利（自當日最低反彈 0.8% 全數回補）
// - 時間風控（§7.4）：11:30 禁開新空單；13:00 強制回補警報
// - 訊號 Payload（§7.5）：action=SELL_TO_OPEN、strategy=BULL_TRAP_VWAP_SHORT、risk_warning
// - 對接 tw-quant-mcp v1.3 實際契約：
//     · 連續 2 根 1 分 K：get_intraday_kline({ symbol, timeframe:'1m' }) 末 2 根 close < vwap
//     · 台指黑棒：get_intraday_kline({ symbol:'TX', timeframe:'1m' }) 末根 open ≥ close（開高走低）
//     · 今日漲跌幅：get_intraday_quote({ symbol }) 之 change_pct（非交易時段 isError → 未知 → Veto 不觸發但註記）

import type { McpCallFn, GateCheckFn } from '../pre_market/types.js';
import type { EventLogger } from '../logging/event_logger.js';

export type ShortDirection = 'SELL_TO_OPEN';

/** 策略參數（§7.2/§7.4；可自 Tactical Briefing 動態載入） */
export interface ShortStrategyParams {
  /** 進場時間窗開始（HH:MM，§7.2 09:15） */
  windowStart: string;
  /** 進場時間窗結束（HH:MM，§7.2 11:30） */
  windowEnd: string;
  /** 今日漲幅 Veto 門檻 %（§7.3 6.5） */
  priceChangeVetoPct: number;
  /** 進場門檻（§7.3 75） */
  entryThreshold: number;
  /** 硬停損趴數（§7.4 0.015） */
  stopLossPct: number;
  /** 停利第一目標趴數（§7.4 0.02） */
  takeProfitPct: number;
  /** 分批回補比例（§7.4 0.5） */
  partialTakePct: number;
  /** 移動停利反彈趴數（§7.4 0.008） */
  trailingStopPct: number;
  /** 最大持有分鐘（§7.5 max_holding_time_minutes） */
  maxHoldingMinutes: number;
  /** 禁開新空單（HH:MM，§7.4 11:30） */
  noNewShortAt: string;
  /** 強制回補（HH:MM，§7.4 13:00） */
  forceCoverAt: string;
}

export const DEFAULT_SHORT_PARAMS: ShortStrategyParams = {
  windowStart: '09:15',
  windowEnd: '11:30',
  priceChangeVetoPct: 6.5,
  entryThreshold: 75,
  stopLossPct: 0.015,
  takeProfitPct: 0.02,
  partialTakePct: 0.5,
  trailingStopPct: 0.008,
  maxHoldingMinutes: 45,
  noNewShortAt: '11:30',
  forceCoverAt: '13:00',
};

export interface ShortEvalInput {
  symbol: string;
  price: number;
  vwap: number;
  /** 開盤前 15 分盤中最低點 */
  dayLow15m: number;
  volumeSurgeType: 'BEARISH_BREAKDOWN' | 'BULLISH_SURGE' | 'NEUTRAL' | string;
  /** 今日漲跌幅 %（如 6.5 = +6.5%） */
  priceChangePct: number;
  /** 連續 2 根 1 分 K 收 VWAP 下方 */
  twoCandlesBelowVwap: boolean;
  /** 台指黑棒（開高走低） */
  taifexBearish: boolean;
  /** 台指趨勢未知 */
  taifexUnknown?: boolean;
}

export interface ShortScoreBreakdown {
  below_vwap: number;
  bearish_breakdown: number;
  breakdown_low: number;
  market_tailwind: number;
  veto_penalty: number;
  total: number;
}

export interface ShortEvaluation {
  conditionsMet: boolean;
  conditions: {
    belowVwap: boolean;
    bearishBreakdown: boolean;
    breakdownLow: boolean;
    marketTailwind: boolean;
    twoCandlesBelowVwap: boolean;
  };
  breakdown: ShortScoreBreakdown;
  score: number;
  shouldEnter: boolean;
  missing: string[];
}

/** 空方資格掃描結果（§7.1） */
export interface ShortEligibility {
  eligible: boolean;
  reasons: string[];
}

/** 策略引擎輸出（§7.5 Signal Payload） */
export interface ShortSignalPayload {
  timestamp: string;
  symbol: string;
  name?: string;
  action: ShortDirection;
  strategy: 'BULL_TRAP_VWAP_SHORT';
  signal_score: number;
  execution_plan: {
    short_entry_price: number;
    suggested_size: string;
    stop_loss_price: number;
    target_price_1: number;
    max_holding_time_minutes: number;
  };
  risk_warning: string;
  rationale: string;
}

export interface BullTrapVwapShortOptions {
  mcpCall: McpCallFn;
  gate: GateCheckFn;
  events?: EventLogger;
  gateScope?: 'PRE_MARKET' | 'INTRADAY_SIGNAL' | 'INTRADAY_MARKET' | 'HISTORICAL';
  params?: Partial<ShortStrategyParams>;
  nowFn?: () => Date;
}

/** 純函式：§7.3 評分（可獨立單測） */
export function scoreShortSignal(input: ShortEvalInput, params: ShortStrategyParams): ShortEvaluation {
  const belowVwap = input.price < input.vwap;
  const bearishBreakdown = input.volumeSurgeType === 'BEARISH_BREAKDOWN';
  const breakdownLow = input.price < input.dayLow15m;
  const marketTailwind = !input.taifexUnknown && input.taifexBearish;

  const breakdown: ShortScoreBreakdown = {
    below_vwap: belowVwap ? 25 : 0,
    bearish_breakdown: bearishBreakdown ? 25 : 0,
    breakdown_low: breakdownLow ? 25 : 0,
    market_tailwind: marketTailwind ? 25 : 0,
    veto_penalty: 0,
    total: 0,
  };
  breakdown.total = breakdown.below_vwap + breakdown.bearish_breakdown + breakdown.breakdown_low + breakdown.market_tailwind;
  if (input.priceChangePct >= params.priceChangeVetoPct) {
    breakdown.veto_penalty = -100;
    breakdown.total += -100;
  }

  const missing: string[] = [];
  if (!belowVwap) missing.push('價格未跌破 VWAP');
  if (!bearishBreakdown) missing.push('無頂部爆量拉回（BEARISH_BREAKDOWN）');
  if (!breakdownLow) missing.push('未跌破盤前低點');
  if (!input.twoCandlesBelowVwap) missing.push('未連續 2 根收 VWAP 下方');
  if (!marketTailwind) missing.push(input.taifexUnknown ? '台指趨勢資料不可用' : '台指未黑棒順風');
  if (breakdown.veto_penalty < 0) missing.push(`今日已漲 ${input.priceChangePct}% ≥ ${params.priceChangeVetoPct}% 嚴禁放空（Veto）`);

  const conditionsMet = belowVwap && bearishBreakdown && breakdownLow && marketTailwind && input.twoCandlesBelowVwap;
  const shouldEnter = conditionsMet && !(breakdown.veto_penalty < 0) && breakdown.total >= params.entryThreshold;

  return {
    conditionsMet,
    conditions: { belowVwap, bearishBreakdown, breakdownLow, marketTailwind, twoCandlesBelowVwap: input.twoCandlesBelowVwap },
    breakdown,
    score: breakdown.total,
    shouldEnter,
    missing,
  };
}

export class BullTrapVwapShortEngine {
  private readonly opts: BullTrapVwapShortOptions;
  private readonly params: ShortStrategyParams;
  private readonly nowFn: () => Date;

  constructor(opts: BullTrapVwapShortOptions) {
    this.opts = opts;
    this.params = { ...DEFAULT_SHORT_PARAMS, ...(opts.params ?? {}) };
    this.nowFn = opts.nowFn ?? (() => new Date());
  }

  /** HH:MM → 秒數 */
  private toSeconds(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 3600 + m * 60;
  }

  private secOf(now: Date): number {
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  }

  /** 進場時間窗（§7.2 09:15–11:30） */
  inWindow(now: Date): boolean {
    const s = this.secOf(now);
    return s >= this.toSeconds(this.params.windowStart) && s <= this.toSeconds(this.params.windowEnd);
  }

  /** 11:30 後禁止開新空單（§7.4） */
  noNewShortDue(now: Date): boolean {
    return this.secOf(now) >= this.toSeconds(this.params.noNewShortAt);
  }

  /** 13:00 強制回補警報（§7.4） */
  forceCoverDue(now: Date): boolean {
    return this.secOf(now) >= this.toSeconds(this.params.forceCoverAt);
  }

  private async fetchGated(tool: string, args: Record<string, unknown>, symbol: string, now: Date) {
    let env: { data?: unknown; _lineage?: Record<string, unknown> };
    try {
      env = await this.opts.mcpCall(tool, args);
    } catch {
      return null;
    }
    const gate = this.opts.gate(env as never, this.opts.gateScope ?? 'INTRADAY_SIGNAL', {
      symbol,
      now,
    } as never);
    if (!gate.passed) return null;
    return (env.data ?? {}) as Record<string, unknown>;
  }

  /** 連續 2 根 1 分 K 收 VWAP 下方（get_intraday_kline({symbol}) 末 2 根） */
  async fetchTwoCandlesBelowVwap(symbol: string, vwap: number, now: Date): Promise<boolean> {
    const data = await this.fetchGated('get_intraday_kline', { symbol, timeframe: '1m', limit: 2 }, symbol, now);
    if (!data) return false;
    const candles = (Array.isArray(data) ? data : ((data.candles ?? []) as unknown[])) as Array<{ close?: number }>;
    const lastTwo = candles.slice(-2);
    if (lastTwo.length < 2) return false;
    return lastTwo.every((c) => typeof c.close === 'number' && c.close < vwap);
  }

  /** 台指黑棒（get_intraday_kline({symbol:'TX'}) 末根 open ≥ close，開高走低） */
  async fetchTaifexBearish(symbol: string, now: Date): Promise<{ bearish: boolean; unknown: boolean }> {
    const data = await this.fetchGated('get_intraday_kline', { symbol: 'TX', timeframe: '1m', limit: 1 }, symbol, now);
    if (!data) return { bearish: false, unknown: true };
    const candles = (Array.isArray(data) ? data : ((data.candles ?? []) as unknown[])) as Array<{
      open?: number;
      close?: number;
    }>;
    const last = candles[candles.length - 1];
    if (!last || typeof last.close !== 'number') return { bearish: false, unknown: true };
    return { bearish: (last.open ?? last.close) >= last.close, unknown: false };
  }

  /** 今日漲跌幅（get_intraday_quote({symbol}) change_pct；未知 → 0 且標註） */
  async fetchPriceChangePct(symbol: string, now: Date): Promise<{ pct: number; unknown: boolean }> {
    const data = await this.fetchGated('get_intraday_quote', { symbol }, symbol, now);
    if (!data) return { pct: 0, unknown: true };
    const pct = Number((data as Record<string, unknown>).change_pct ?? (data as Record<string, unknown>).price_change_pct ?? 0);
    return { pct: Number.isFinite(pct) ? pct : 0, unknown: false };
  }

  /** 資格掃描（§7.1）：風控關卡（scan_daytrade_eligibility 過守門 + 三條件全過） */
  async checkEligibility(symbol: string, now: Date): Promise<ShortEligibility> {
    let env: { data?: unknown; _lineage?: Record<string, unknown> };
    try {
      env = await this.opts.mcpCall('scan_daytrade_eligibility', { symbol });
    } catch {
      return { eligible: false, reasons: ['風控關卡呼叫失敗（非交易時段或連線中斷）'] };
    }
    const gate = this.opts.gate(env as never, this.opts.gateScope ?? 'INTRADAY_SIGNAL', { symbol, now } as never);
    if (!gate.passed) {
      return { eligible: false, reasons: [`風控關卡資料守門失敗（${gate.cause ?? 'unknown'}）`] };
    }
    const d = (env.data ?? {}) as Record<string, unknown>;
    const reasons: string[] = [];
    if (d.can_short_first !== true) reasons.push('未開放先賣後買當沖');
    if (d.margin_short_available !== true) reasons.push('資券狀況不允許放空');
    if (d.is_disposition === true) reasons.push('處置股禁止當沖空單');
    return { eligible: reasons.length === 0, reasons };
  }

  /**
   * 評估單一標的（§7.2–7.3）。
   * @param symbol 標的代號
   * @param price 當前價格
   * @param vwap 當前 VWAP
   * @param dayLow15m 盤前 15 分低點
   * @param surgeType 爆量類型（detect_volume_surge.volumeSurgeType）
   * @param priceChangePct 今日漲跌幅 %（可預先取得；省略時引擎自行 fetch）
   */
  async evaluate(
    symbol: string,
    price: number,
    vwap: number,
    dayLow15m: number,
    surgeType: string,
    priceChangePct?: number,
    now: Date = this.nowFn(),
  ): Promise<ShortEvaluation> {
    const empty: ShortEvaluation = {
      conditionsMet: false,
      conditions: { belowVwap: false, bearishBreakdown: false, breakdownLow: false, marketTailwind: false, twoCandlesBelowVwap: false },
      breakdown: { below_vwap: 0, bearish_breakdown: 0, breakdown_low: 0, market_tailwind: 0, veto_penalty: 0, total: 0 },
      score: 0,
      shouldEnter: false,
      missing: [],
    };
    // 11:30 禁開新空單優先
    if (this.noNewShortDue(now)) {
      return { ...empty, missing: [`已過 ${this.params.noNewShortAt} 禁止開新空單`] };
    }
    if (!this.inWindow(now)) {
      return { ...empty, missing: [`不在進場時間窗 ${this.params.windowStart}–${this.params.windowEnd}`] };
    }

    // 資料取得（並行）：連續 2 根收 VWAP 下 / 台指黑棒 / 今日漲跌幅
    const [twoCandles, taifex, change] = await Promise.all([
      this.fetchTwoCandlesBelowVwap(symbol, vwap, now),
      this.fetchTaifexBearish(symbol, now),
      priceChangePct !== undefined
        ? Promise.resolve({ pct: priceChangePct, unknown: false })
        : this.fetchPriceChangePct(symbol, now),
    ]);

    const evalResult = scoreShortSignal(
      {
        symbol,
        price,
        vwap,
        dayLow15m,
        volumeSurgeType: surgeType,
        priceChangePct: change.pct,
        twoCandlesBelowVwap: twoCandles,
        taifexBearish: taifex.bearish,
        taifexUnknown: taifex.unknown,
      },
      this.params,
    );
    return evalResult;
  }

  /** 建構 §7.5 Signal Payload（含 risk_warning） */
  buildPayload(
    symbol: string,
    name: string | undefined,
    price: number,
    evalResult: ShortEvaluation,
    eligibility: ShortEligibility,
    priceChangePct: number,
    now: Date = this.nowFn(),
  ): ShortSignalPayload {
    const entry = price;
    const stopLoss = entry * (1 + this.params.stopLossPct);
    const target1 = entry * (1 - this.params.takeProfitPct);
    const ts = now.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00';
    const distToLimitUp = Math.max(0, this.params.priceChangeVetoPct - priceChangePct).toFixed(1);
    const riskWarning = eligibility.eligible
      ? `當前股價距漲停板尚有 ${distToLimitUp}% 空間，資券狀況無虞，開放先賣後買。`
      : `資格警示：${eligibility.reasons.join('；')}`;
    return {
      timestamp: ts,
      symbol,
      name,
      action: 'SELL_TO_OPEN',
      strategy: 'BULL_TRAP_VWAP_SHORT',
      signal_score: evalResult.score,
      execution_plan: {
        short_entry_price: Math.round(entry * 100) / 100,
        suggested_size: '1~2 張',
        stop_loss_price: Math.round(stopLoss * 100) / 100,
        target_price_1: Math.round(target1 * 100) / 100,
        max_holding_time_minutes: this.params.maxHoldingMinutes,
      },
      risk_warning: riskWarning,
      rationale: evalResult.missing.length > 0
        ? `未滿足：${evalResult.missing.join('、')}`
        : `衝高後爆量急退，連續 2 分鐘收在 VWAP 下方，大盤台指期開高走低，空方動能強勁（score ${evalResult.score}）`,
    };
  }

  /** 完整流程：資格掃描 + 評估 +（通過時）寫事件 + 回傳 payload */
  async run(
    symbol: string,
    name: string | undefined,
    price: number,
    vwap: number,
    dayLow15m: number,
    surgeType: string,
    priceChangePct?: number,
    now: Date = this.nowFn(),
  ): Promise<{
    eligibility: ShortEligibility;
    evaluation: ShortEvaluation;
    payload: ShortSignalPayload | null;
  }> {
    const eligibility = await this.checkEligibility(symbol, now);
    if (!eligibility.eligible) {
      return { eligibility, evaluation: await this.evaluate(symbol, price, vwap, dayLow15m, surgeType, priceChangePct, now), payload: null };
    }
    const evaluation = await this.evaluate(symbol, price, vwap, dayLow15m, surgeType, priceChangePct, now);
    if (evaluation.shouldEnter) {
      const effectiveChange = priceChangePct ?? 0;
      const payload = this.buildPayload(symbol, name, price, evaluation, eligibility, effectiveChange, now);
      if (this.opts.events) {
        this.opts.events.write('signal_issued', {
          signal_id: `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false }).replace(/:/g, '')}`,
          symbol,
          score: evaluation.score,
          grade: 'STRONG_SELL',
          strategy: 'BULL_TRAP_VWAP_SHORT',
        }, now);
      }
      return { eligibility, evaluation, payload };
    }
    return { eligibility, evaluation, payload: null };
  }
}
