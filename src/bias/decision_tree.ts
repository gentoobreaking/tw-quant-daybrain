// Bias Decision Tree（T016，§5 盤前多空傾向鎖定）
// - 08:30–08:55 執行，08:55 正式鎖定 LONG_ONLY / SHORT_ONLY / NEUTRAL_FLEXIBLE / NO_TRADE
// - 四階段（§5.1）：風控硬性關卡 → 籌碼/趨勢基調 → 消息與夜盤共振 → 盤前試撮驗證
// - 評分（§5.2）：日線趨勢 ±20 / 法人籌碼 ±25 / 夜盤美股 ±25 / 盤前試撮 ±30（-100 ~ +100）
// - 鎖定規則（§5.3）：≥ +50 LONG_ONLY、≤ -50 SHORT_ONLY（無法先賣後買改判 NO_TRADE）、中間 NEUTRAL_FLEXIBLE、硬風控旗標 NO_TRADE
// - 所有 MCP 輸入先過 T003 守門；單節點資料逾時/失敗/工具不存在 → 該節點 0 分並於 rationale 註記
// - 對接 tw-quant-mcp v1.3 實際契約（37 tools，非 spec §2.2 理想 18 tools）：
//     · 法人籌碼：get_institutional_investors({ market }) → data.rows[] 找 code（當日 total_net 代理近 3 日）
//     · 夜盤：get_futures_daily_ohlc({ contract:'TX' }) → session=盤後 change_pct
//     · 美股 ADR / 盤前試撮：實際契約無對應工具 → 節點 0 分 + rationale 註記
// - 輸出 { bias, score, rationale }（§5.4 evaluateDayTradeBias），鎖定結果寫 bias_locked 事件

import type { McpCallFn, GateCheckFn } from '../pre_market/types.js';
import type { EventLogger } from '../logging/event_logger.js';

export type DayTradeBias = 'LONG_ONLY' | 'SHORT_ONLY' | 'NEUTRAL_FLEXIBLE' | 'NO_TRADE';

export interface BiasResult {
  bias: DayTradeBias;
  score: number;
  rationale: string;
}

export interface BiasNodeScores {
  /** 日線趨勢（±20） */
  trend: number;
  /** 法人籌碼（±25） */
  institutional: number;
  /** 夜盤與美股（±25） */
  overnight: number;
  /** 盤前試撮（±30） */
  preMarket: number;
}

export interface BiasOptions {
  mcpCall: McpCallFn;
  gate: GateCheckFn;
  events?: EventLogger;
  /** 守門 scope（預設 PRE_MARKET） */
  gateScope?: 'PRE_MARKET' | 'INTRADAY_SIGNAL' | 'INTRADAY_MARKET' | 'HISTORICAL';
  /** 夜盤共振門檻 %（§5.2 0.5） */
  overnightThresholdPct?: number;
  /** 市場別（法人資料，預設 tse） */
  market?: 'tse' | 'otc';
  /** 日線 MA 計算所需根數（預設 20） */
  maLookback?: number;
}

const DEFAULT_OVERNIGHT_THRESHOLD_PCT = 0.5;
const DEFAULT_MA_LOOKBACK = 20;

/** 單節點資料提取結果（null = 守門失敗/工具不可用 → 0 分） */
type NodeData = Record<string, unknown> | null;

/** 簡單移動平均（對齊 tw-quant-mcp 日 K 收盤價） */
export function simpleMovingAverage(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * 呼叫 MCP 工具並過守門；失敗回 null（該節點 0 分並由呼叫端註記）。
 * 注意：守門依業務時鐘（options.now），避免跨日/測試時間敏感。
 */
async function fetchGated(
  opts: BiasOptions,
  tool: string,
  args: Record<string, unknown>,
  symbol: string,
  now: Date,
): Promise<NodeData> {
  let env: { data?: unknown; _lineage?: Record<string, unknown> };
  try {
    env = await opts.mcpCall(tool, args);
  } catch {
    return null; // 呼叫例外（工具不存在/連線中斷）→ 0 分
  }
  const gate = opts.gate(env as never, opts.gateScope ?? 'PRE_MARKET', {
    symbol,
    now,
  } as never);
  if (!gate.passed) {
    return null;
  }
  return (env.data ?? {}) as Record<string, unknown>;
}

export class BiasDecisionTree {
  private readonly opts: BiasOptions;
  private readonly overnightThresholdPct: number;
  private readonly maLookback: number;

  constructor(opts: BiasOptions) {
    this.opts = opts;
    this.overnightThresholdPct = opts.overnightThresholdPct ?? DEFAULT_OVERNIGHT_THRESHOLD_PCT;
    this.maLookback = opts.maLookback ?? DEFAULT_MA_LOOKBACK;
  }

  /**
   * 評估單一標的之盤前多空傾向（§5.4 evaluateDayTradeBias 對齊簽名）。
   * @param symbol 股票代號
   * @param now 業務時鐘（08:30–08:55 評估窗；測試可注入）
   */
  async evaluate(symbol: string, now: Date = new Date()): Promise<BiasResult> {
    const logs: string[] = [];
    const scores: BiasNodeScores = { trend: 0, institutional: 0, overnight: 0, preMarket: 0 };

    // ── 階段 1：風控硬性關卡（§5.1 Node 1 / §5.3 硬風控旗標）──
    // scan_daytrade_eligibility 本身亦過守門；失敗/呼叫例外視同無法確認資格 → 保守 NO_TRADE
    let elig: { can_daytrade?: boolean; can_short_first?: boolean; is_disposition?: boolean; is_attention?: boolean } = {};
    try {
      const eligEnv = await this.opts.mcpCall('scan_daytrade_eligibility', { symbol });
      const eligGate = this.opts.gate(eligEnv as never, this.opts.gateScope ?? 'PRE_MARKET', {
        symbol,
        now,
      } as never);
      if (!eligGate.passed) {
        return {
          bias: 'NO_TRADE',
          score: 0,
          rationale: `風控關卡資料守門失敗（${eligGate.cause ?? 'unknown'}）→ 無法確認當沖資格，保守 NO_TRADE`,
        };
      }
      elig = (eligEnv.data ?? {}) as typeof elig;
    } catch {
      return {
        bias: 'NO_TRADE',
        score: 0,
        rationale: '風控關卡呼叫失敗（非交易時段或連線中斷）→ 無法確認當沖資格，保守 NO_TRADE',
      };
    }
    if (!elig.can_daytrade || elig.is_disposition || elig.is_attention) {
      return {
        bias: 'NO_TRADE',
        score: 0,
        rationale: `該標的今日${elig.is_disposition ? '處置中' : elig.is_attention ? '列為注意股' : '不可當沖'} → 禁止交易`,
      };
    }

    // ── 階段 2：籌碼與日線趨勢（§5.2 節點 1/2）──
    // 日線趨勢：get_stock_daily_kline（data 為日K陣列）自行計算 MA5/MA20
    const kline = await fetchGated(this.opts, 'get_stock_daily_kline', { symbol }, symbol, now);
    if (!kline) {
      logs.push('日線趨勢資料守門失敗→0 分');
    } else {
      const rows = (Array.isArray(kline) ? kline : (kline.candles as unknown[]) ?? []) as Array<{
        close?: number;
        timestamp?: string;
      }>;
      const closes = rows.map((r) => Number(r.close)).filter((n) => Number.isFinite(n));
      if (closes.length >= 5) {
        const price = closes[closes.length - 1];
        const ma5 = simpleMovingAverage(closes, 5);
        const ma20 = this.maLookback <= 20 ? simpleMovingAverage(closes, 20) : 0;
        if (ma20 > 0 && price > ma5 && price > ma20) {
          scores.trend = 20;
          logs.push(`日線多頭排列（價 ${price} > MA5 ${ma5.toFixed(1)} > MA20 ${ma20.toFixed(1)}）(+20)`);
        } else if (ma20 > 0 && price < ma5 && price < ma20) {
          scores.trend = -20;
          logs.push(`日線空頭排列（價 ${price} < MA5 ${ma5.toFixed(1)} < MA20 ${ma20.toFixed(1)}）(-20)`);
        } else {
          logs.push(`日線位階中性（價 ${price} / MA5 ${ma5.toFixed(1)} / MA20 ${ma20.toFixed(1)}）(0)`);
        }
      } else {
        logs.push(`日線資料不足 ${closes.length} 根→0 分`);
      }
    }

    // 法人籌碼：get_institutional_investors({ market }) → data.rows[] 找 code（當日 total_net 代理）
    const chip = await fetchGated(this.opts, 'get_institutional_investors', { market: this.opts.market ?? 'tse' }, symbol, now);
    if (!chip) {
      logs.push('法人籌碼資料守門失敗→0 分');
    } else {
      const rows = (Array.isArray(chip) ? chip : (chip.rows as unknown[]) ?? []) as Array<{
        code?: string | number;
        total_net?: number;
      }>;
      const row = rows.find((r) => String(r.code) === symbol);
      const netBuy = row?.total_net ?? 0;
      if (row && netBuy > 0) {
        scores.institutional = 25;
        logs.push(`三大法人當日買超 ${netBuy.toLocaleString()}（近 3 日累計以當日代理）(+25)`);
      } else if (row && netBuy < 0) {
        scores.institutional = -25;
        logs.push(`三大法人當日賣超 ${Math.abs(netBuy).toLocaleString()}（近 3 日累計以當日代理）(-25)`);
      } else {
        logs.push(row ? `法人籌碼中性（total_net ${netBuy}）(0)` : `法人明細無 ${symbol}(0)`);
      }
    }

    // ── 階段 3：消息與夜盤共振（§5.2 節點 3）──
    // 夜盤：get_futures_daily_ohlc({ contract:'TX' }) → session=盤後 之 change_pct
    // 美股 ADR：實際契約無 get_us_market → 節點以夜盤單邊評估（美股 0 分註記）
    const night = await fetchGated(this.opts, 'get_futures_daily_ohlc', { contract: 'TX' }, symbol, now);
    if (!night) {
      logs.push('夜盤資料守門失敗→0 分');
    } else {
      const rows = (Array.isArray(night) ? night : (night.candles as unknown[]) ?? []) as Array<{
        session?: string;
        change_pct?: number;
      }>;
      const nightRow = rows.find((r) => r.session === '盤後') ?? rows[rows.length - 1];
      const nightChange = Number(nightRow?.change_pct ?? 0);
      // 美股 ADR 無工具：視為「無共振資訊」，夜盤單邊 > 門檻仍給分（維持 ±25 節點），
      // 但 rationale 註記 ADR 無法驗證（保守：僅夜盤達標且幅度 ≥ 門檻才給分）
      if (nightChange > this.overnightThresholdPct) {
        scores.overnight = 25;
        logs.push(`台指夜盤 +${nightChange.toFixed(2)}% 強勢（美股 ADR 無資料源，未驗證）(+25)`);
      } else if (nightChange < -this.overnightThresholdPct) {
        scores.overnight = -25;
        logs.push(`台指夜盤 ${nightChange.toFixed(2)}% 弱勢（美股 ADR 無資料源，未驗證）(-25)`);
      } else {
        logs.push(`台指夜盤 ${nightChange.toFixed(2)}% 無共振 (0)`);
      }
    }

    // ── 階段 4：盤前試撮驗證（§5.2 節點 4）──
    // 實際契約無 get_pre_market_quote → 節點 0 分 + 註記（避免假設不存在的工具）
    logs.push('盤前試撮資料源（get_pre_market_quote）於 tw-quant-mcp v1.3 契約不存在→0 分');

    // ── 階段 5：鎖定規則（§5.3）──
    const score = scores.trend + scores.institutional + scores.overnight + scores.preMarket;
    let bias: DayTradeBias = 'NEUTRAL_FLEXIBLE';
    let lockLog = '';
    if (score >= 50) {
      bias = 'LONG_ONLY';
      lockLog = `總分 ${score} ≥ +50 → LONG_ONLY（屏蔽空訊）`;
    } else if (score <= -50) {
      if (elig.can_short_first === false) {
        this.writeEvent(symbol, 'NO_TRADE', score, now, '空方訊號成立但該股今日無法先賣後買');
        return {
          bias: 'NO_TRADE',
          score,
          rationale: `空方訊號成立（${logs.join(' | ')}）但該股今日無法先賣後買 → NO_TRADE`,
        };
      }
      bias = 'SHORT_ONLY';
      lockLog = `總分 ${score} ≤ -50 → SHORT_ONLY（屏蔽多訊）`;
    } else {
      lockLog = `總分 ${score} 落於中間帶 → NEUTRAL_FLEXIBLE（門檻提高至 85 分）`;
    }

    logs.push(lockLog);
    const rationale = logs.join(' | ');
    this.writeEvent(symbol, bias, score, now, lockLog);
    return { bias, score, rationale };
  }

  private writeEvent(
    symbol: string,
    bias: DayTradeBias,
    score: number,
    now: Date,
    lockLog: string,
  ): void {
    if (!this.opts.events) return;
    this.opts.events.write(
      'bias_locked',
      { symbol, bias, score, rationale: lockLog },
      now,
    );
  }
}

/** 便利函式：單次評估（§5.4 簽名對齊，供 phase0/phase1 或 CLI 呼叫） */
export async function evaluateDayTradeBias(
  opts: BiasOptions,
  symbol: string,
  now: Date = new Date(),
): Promise<BiasResult> {
  const tree = new BiasDecisionTree(opts);
  return tree.evaluate(symbol, now);
}
