// VWAP_SURGE_LONG 做多策略引擎（T017，§6）
// - 適用：權值股（如 2308 台達電）；做多 VWAP 爆量突破
// - 進場四條件（§6.2）：時間窗 09:05–11:30、VWAP 站穩（偏離 ≤ +1.5%）、爆量 ≥2.5 倍、
//   突破盤前 15 分高點、台指期 1 分 K 紅棒順風
// - 評分（§6.3）：四條件各 +25（4×25 分制，與 §8 同源）；距漲停 <1.5% 扣 50（Veto）
// - 停損停利（§6.4）：硬停損 -1.5% 或跌破 VWAP 持續 1 分鐘；+2.0% 平 50%、剩餘移動停利（自高點回檔 1.0%）
// - 時間硬風控（§6.4）：12:30 停訊、13:10 FORCE_FLAT_ALL 強制平倉警告
// - 訊號 Payload（§6.5）：timestamp/symbol/action=BUY_TO_OPEN/strategy/signal_score/
//   execution_plan(entry/suggested_size/stop_loss/target_1/max_holding_time)/rationale
// - 對接 tw-quant-mcp v1.3 實際契約：
//     · 台指紅棒：get_intraday_kline({ symbol:'TX', timeframe:'1m' }) 末根 close ≥ open
//     · Anchor：get_stock_daily_kline({ symbol, date: 月初 }) 取前一日收盤/高低
//     · 非交易時段 MCP 回 isError → 該輸入視為不可用（順風 0 分註記，不 throw）

import type { McpCallFn, GateCheckFn } from '../pre_market/types.js';
import type { EventLogger } from '../logging/event_logger.js';

export type LongDirection = 'BUY_TO_OPEN';

/** 策略參數（§6.2/§6.4；可自 Tactical Briefing 動態載入，不硬編碼） */
export interface LongStrategyParams {
  /** 進場時間窗開始（HH:MM，§6.2 09:05） */
  windowStart: string;
  /** 進場時間窗結束（HH:MM，§6.2 11:30） */
  windowEnd: string;
  /** VWAP 偏離上限（小數，§6.2 0.015） */
  maxVwapDeviationPct: number;
  /** 爆量倍數門檻（§6.2 2.5） */
  volumeSurgeMin: number;
  /** 距漲停扣分門檻（小數，§6.3 0.015） */
  distanceToLimitUpVetoPct: number;
  /** 進場門檻（§6.3 75；NEUTRAL 日 85） */
  entryThreshold: number;
  /** 硬停損趴數（§6.4 0.015） */
  stopLossPct: number;
  /** 停利第一目標趴數（§6.4 0.02） */
  takeProfitPct: number;
  /** 分批比例（§6.4 0.5 = 平 50%） */
  partialTakePct: number;
  /** 移動停利回檔趴數（§6.4 0.01） */
  trailingStopPct: number;
  /** 最大持有分鐘（§6.5 max_holding_time_minutes） */
  maxHoldingMinutes: number;
  /** 12:30 停止發訊（HH:MM） */
  stopSignalAt: string;
  /** 13:10 強制平倉（HH:MM） */
  forceFlatAt: string;
}

export const DEFAULT_LONG_PARAMS: LongStrategyParams = {
  windowStart: '09:05',
  windowEnd: '11:30',
  maxVwapDeviationPct: 0.015,
  volumeSurgeMin: 2.5,
  distanceToLimitUpVetoPct: 0.015,
  entryThreshold: 75,
  stopLossPct: 0.015,
  takeProfitPct: 0.02,
  partialTakePct: 0.5,
  trailingStopPct: 0.01,
  maxHoldingMinutes: 60,
  stopSignalAt: '12:30',
  forceFlatAt: '13:10',
};

export interface LongEvalInput {
  symbol: string;
  price: number;
  vwap: number;
  /** 盤前 15 分高點（當日高點） */
  dayHigh: number;
  volumeSurgeRatio: number;
  isSurge: boolean;
  /** 距漲停剩餘幅度（小數，如 0.015 = 1.5%） */
  distanceToLimitUpPct: number;
  /** 台指期 1 分 K 紅棒 */
  taifexBullish: boolean;
  /** 台指趨勢未知（資料不可用） */
  taifexUnknown?: boolean;
}

export interface LongScoreBreakdown {
  vwap_hold: number;
  volume_surge: number;
  breakout: number;
  market_tailwind: number;
  veto_penalty: number;
  total: number;
}

export interface LongEvaluation {
  /** 四條件是否全數滿足（§6.2） */
  conditionsMet: boolean;
  /** 逐條件 */
  conditions: {
    vwapHold: boolean;
    volumeSurge: boolean;
    breakout: boolean;
    marketTailwind: boolean;
  };
  breakdown: LongScoreBreakdown;
  score: number;
  /** score ≥ entryThreshold 且未 veto */
  shouldEnter: boolean;
  /** 未滿足條件說明（供 rationale） */
  missing: string[];
}

/** 策略引擎輸出（§6.5 Signal Payload 對齊） */
export interface LongSignalPayload {
  timestamp: string;
  symbol: string;
  name?: string;
  action: LongDirection;
  strategy: 'VWAP_SURGE_LONG';
  signal_score: number;
  execution_plan: {
    entry_price: number;
    suggested_size: string;
    stop_loss_price: number;
    target_price_1: number;
    max_holding_time_minutes: number;
  };
  rationale: string;
}

export interface VwapSurgeLongOptions {
  mcpCall: McpCallFn;
  gate: GateCheckFn;
  events?: EventLogger;
  /** 守門 scope（預設 INTRADAY_SIGNAL） */
  gateScope?: 'PRE_MARKET' | 'INTRADAY_SIGNAL' | 'INTRADAY_MARKET' | 'HISTORICAL';
  params?: Partial<LongStrategyParams>;
  /** 時鐘（測試注入） */
  nowFn?: () => Date;
}

/** 純函式：§6.3 評分（可獨立單測） */
export function scoreLongSignal(input: LongEvalInput, params: LongStrategyParams): LongEvaluation {
  const vwapHold = input.price > input.vwap && (input.price - input.vwap) / input.vwap <= params.maxVwapDeviationPct;
  const volumeSurge = input.isSurge && input.volumeSurgeRatio >= params.volumeSurgeMin;
  const breakout = input.price >= input.dayHigh;
  // 台指未知 → 不給分但不算條件失敗（保守：順風僅在明確紅棒時成立）
  const marketTailwind = !input.taifexUnknown && input.taifexBullish;

  const breakdown: LongScoreBreakdown = {
    vwap_hold: vwapHold ? 25 : 0,
    volume_surge: volumeSurge ? 25 : 0,
    breakout: breakout ? 25 : 0,
    market_tailwind: marketTailwind ? 25 : 0,
    veto_penalty: 0,
    total: 0,
  };
  breakdown.total = breakdown.vwap_hold + breakdown.volume_surge + breakdown.breakout + breakdown.market_tailwind;
  if (input.distanceToLimitUpPct < params.distanceToLimitUpVetoPct) {
    breakdown.veto_penalty = -50;
    breakdown.total += -50;
  }

  const missing: string[] = [];
  if (!vwapHold) missing.push('VWAP 未站穩或偏離過大');
  if (!volumeSurge) missing.push('爆量未達門檻');
  if (!breakout) missing.push('未突破盤前高點');
  if (!marketTailwind) missing.push(input.taifexUnknown ? '台指趨勢資料不可用' : '台指未紅棒順風');
  if (breakdown.veto_penalty < 0) missing.push('距漲停 <1.5% 利潤空間不足（Veto）');

  const conditionsMet = vwapHold && volumeSurge && breakout && marketTailwind;
  const shouldEnter = conditionsMet && !(breakdown.veto_penalty < 0) && breakdown.total >= params.entryThreshold;

  return {
    conditionsMet,
    conditions: { vwapHold, volumeSurge, breakout, marketTailwind },
    breakdown,
    score: breakdown.total,
    shouldEnter,
    missing,
  };
}

export class VwapSurgeLongEngine {
  private readonly opts: VwapSurgeLongOptions;
  private readonly params: LongStrategyParams;
  private readonly nowFn: () => Date;

  constructor(opts: VwapSurgeLongOptions) {
    this.opts = opts;
    this.params = { ...DEFAULT_LONG_PARAMS, ...(opts.params ?? {}) };
    this.nowFn = opts.nowFn ?? (() => new Date());
  }

  /** 目前台北時間 HH:MM */
  private hhmm(now: Date): string {
    return now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false }).slice(0, 5);
  }

  /** HH:MM → 當日秒數（時間窗邊界比較，含秒級） */
  private toSeconds(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 3600 + m * 60;
  }

  /** 是否在進場時間窗內（§6.2 09:05–11:30；含 start 整點與 end 整點整秒） */
  inWindow(now: Date): boolean {
    const sec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    return sec >= this.toSeconds(this.params.windowStart) && sec <= this.toSeconds(this.params.windowEnd);
  }

  /** 12:30 後停止發訊（§6.4 時間硬風控） */
  signalStopped(now: Date): boolean {
    return this.hhmm(now) >= this.params.stopSignalAt;
  }

  /** 13:10 強制平倉警告（§6.4） */
  forceFlatDue(now: Date): boolean {
    return this.hhmm(now) >= this.params.forceFlatAt;
  }

  /** 守門 + 提取 data（失敗回 null） */
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

  /** 取得台指 1 分 K 紅棒狀態（get_intraday_kline({symbol:'TX'}) 末根） */
  async fetchTaifexBullish(symbol: string, now: Date): Promise<{ bullish: boolean; unknown: boolean }> {
    const data = await this.fetchGated('get_intraday_kline', { symbol: 'TX', timeframe: '1m', limit: 1 }, symbol, now);
    if (!data) return { bullish: false, unknown: true };
    const candles = (Array.isArray(data) ? data : (data.candles as unknown[])) as Array<{
      open?: number;
      close?: number;
    }>;
    const last = candles[candles.length - 1];
    if (!last || typeof last.close !== 'number') return { bullish: false, unknown: true };
    return { bullish: last.close >= (last.open ?? last.close), unknown: false };
  }

  /**
   * 評估單一標的（§6.2–6.5）。
   * @param symbol 標的代號
   * @param price 當前價格
   * @param vwap 當前 VWAP
   * @param dayHigh 盤前 15 分高點
   * @param surge 爆量結果（is_surge / volumeSurgeRatio / volumeSurgeType）
   * @param distanceToLimitUpPct 距漲停幅度（小數）
   * @param now 業務時鐘
   */
  async evaluate(
    symbol: string,
    price: number,
    vwap: number,
    dayHigh: number,
    surge: { is_surge?: boolean; volumeSurgeRatio?: number; volumeSurgeType?: string },
    distanceToLimitUpPct: number,
    now: Date = this.nowFn(),
  ): Promise<LongEvaluation> {
    const empty: LongEvaluation = {
      conditionsMet: false,
      conditions: { vwapHold: false, volumeSurge: false, breakout: false, marketTailwind: false },
      breakdown: { vwap_hold: 0, volume_surge: 0, breakout: 0, market_tailwind: 0, veto_penalty: 0, total: 0 },
      score: 0,
      shouldEnter: false,
      missing: [],
    };
    // 12:30 停訊優先於時間窗（§6.4 時間硬風控）
    if (this.signalStopped(now)) {
      return { ...empty, missing: [`已過 ${this.params.stopSignalAt} 停止發訊`] };
    }
    // 時間窗檢查
    if (!this.inWindow(now)) {
      return { ...empty, missing: [`不在進場時間窗 ${this.params.windowStart}–${this.params.windowEnd}`] };
    }

    // 台指順風（非交易時段 isError → unknown → 0 分）
    const taifex = await this.fetchTaifexBullish(symbol, now);

    const evalResult = scoreLongSignal(
      {
        symbol,
        price,
        vwap,
        dayHigh,
        volumeSurgeRatio: surge.volumeSurgeRatio ?? 0,
        isSurge: surge.is_surge ?? false,
        distanceToLimitUpPct,
        taifexBullish: taifex.bullish,
        taifexUnknown: taifex.unknown,
      },
      this.params,
    );
    return evalResult;
  }

  /** 建構 §6.5 Signal Payload */
  buildPayload(
    symbol: string,
    name: string | undefined,
    price: number,
    evalResult: LongEvaluation,
    now: Date = this.nowFn(),
  ): LongSignalPayload {
    const entry = price;
    const stopLoss = entry * (1 - this.params.stopLossPct);
    const target1 = entry * (1 + this.params.takeProfitPct);
    const ts = now.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00';
    return {
      timestamp: ts,
      symbol,
      name,
      action: 'BUY_TO_OPEN',
      strategy: 'VWAP_SURGE_LONG',
      signal_score: evalResult.score,
      execution_plan: {
        entry_price: Math.round(entry * 100) / 100,
        suggested_size: '1~2 張',
        stop_loss_price: Math.round(stopLoss * 100) / 100,
        target_price_1: Math.round(target1 * 100) / 100,
        max_holding_time_minutes: this.params.maxHoldingMinutes,
      },
      rationale: evalResult.missing.length > 0
        ? `未滿足：${evalResult.missing.join('、')}`
        : `爆量突破盤前高點，價格站穩 VWAP，台指紅棒順風（score ${evalResult.score}）`,
    };
  }

  /** 完整流程：評估 +（通過時）寫事件 + 回傳 payload */
  async run(
    symbol: string,
    name: string | undefined,
    price: number,
    vwap: number,
    dayHigh: number,
    surge: { is_surge?: boolean; volumeSurgeRatio?: number; volumeSurgeType?: string },
    distanceToLimitUpPct: number,
    now: Date = this.nowFn(),
  ): Promise<{ evaluation: LongEvaluation; payload: LongSignalPayload | null }> {
    const evaluation = await this.evaluate(symbol, price, vwap, dayHigh, surge, distanceToLimitUpPct, now);
    if (evaluation.shouldEnter) {
      const payload = this.buildPayload(symbol, name, price, evaluation, now);
      if (this.opts.events) {
        this.opts.events.write('signal_issued', {
          signal_id: `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false }).replace(/:/g, '')}`,
          symbol,
          score: evaluation.score,
          grade: evaluation.score >= 85 ? 'STRONG_BUY' : 'STRONG_BUY',
          strategy: 'VWAP_SURGE_LONG',
        }, now);
      }
      return { evaluation, payload };
    }
    return { evaluation, payload: null };
  }
}
