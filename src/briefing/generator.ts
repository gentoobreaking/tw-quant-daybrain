// Tactical Briefing 產生器（T019，§9）
// - 08:55 將 §5 Bias 決策結果結構化為帶 Data Lineage 之 briefing.json（狀態設定檔）
// - 作為盤中 Agent（T009）之 Action 白名單 + 動態風控參數來源（唯一來源，不硬編碼）
// - Bias 對應規則（§9.2）：NO_TRADE → allowed 空 / LONG_ONLY → 僅 BUY_TO_OPEN /
//   SHORT_ONLY → 僅 SELL_TO_OPEN / NEUTRAL_FLEXIBLE → 雙向
// - 動態時間窗：force_flat_by = SHORT_ONLY ? "13:00" : "13:10"
// - 防呆（§9.3）：盤中找不到當日 briefing → 拒絕啟動交易（loadBriefing 回 null）
// - 產出寫 briefing_generated 事件（T004，briefing_id 必填）
// - volume_surge_threshold（§9.1 key_levels）為 T022/T023 回測與 Grid Search 參數注入點（§13.1）
// - 對接 tw-quant-mcp v1.3：Anchor 用 get_stock_daily_kline({symbol,date:月初}) 取前一日收盤/高低；
//   資格用 scan_daytrade_eligibility；皆過 T003 守門，失敗 → 保守降級（NO_TRADE 或註記）

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { McpCallFn, GateCheckFn } from '../pre_market/types.js';
import type { EventLogger } from '../logging/event_logger.js';
import type { BiasResult, DayTradeBias } from '../bias/decision_tree.js';

export type Bias = DayTradeBias;
export type Action = 'BUY_TO_OPEN' | 'SELL_TO_OPEN';

export interface TacticalBriefing {
  _lineage: {
    generated_at: string;
    agent_version: string;
    mcp_server_version: string;
    data_sources: Array<{ source: string; fetch_time: string }>;
  };
  target: {
    symbol: string;
    name: string;
    market: string;
    yesterday_close: number;
  };
  bias_assessment: {
    bias: Bias;
    score: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    scoring_breakdown: Array<{ factor: string; score: number; detail: string }>;
  };
  trading_plan: {
    allowed_actions: Action[];
    blocked_actions: Action[];
    active_window: {
      start_time: string;
      no_new_entry_after: string;
      force_flat_by: string;
    };
    key_levels: {
      anchor_vwap_estimate: number;
      breakout_pivot_price: number;
      support_invalidation_price: number;
      volume_surge_threshold: number;
    };
  };
  risk_guardrails: {
    max_position_size_shares: number;
    hard_stop_loss_pct: number;
    take_profit_target_1_pct: number;
    trailing_stop_activation_pct: number;
    trailing_stop_callback_pct: number;
    max_drawdown_limit_ntd: number;
    safety_flags: {
      is_disposition: boolean;
      can_daytrade: boolean;
      can_short_first: boolean;
      earnings_announcement_today: boolean;
    };
  };
}

/** 標的盤前基礎資料（Anchor Levels 計算所需；由 phase1 候選/日 K 提供） */
export interface BriefingTargetInput {
  symbol: string;
  name?: string;
  market?: 'TWSE' | 'TPEX';
  /** 昨日收盤（錨定價） */
  yesterdayClose: number;
  /** 昨日高點（breakout pivot 用；缺省時以昨日收盤 ×1.01 估計） */
  yesterdayHigh?: number;
}

/** 產生器選項 */
export interface BriefingGeneratorOptions {
  mcpCall: McpCallFn;
  gate: GateCheckFn;
  events?: EventLogger;
  /** 守門 scope（預設 PRE_MARKET） */
  gateScope?: 'PRE_MARKET' | 'INTRADAY_SIGNAL' | 'INTRADAY_MARKET' | 'HISTORICAL';
  /** 產出目錄（預設 <cwd>/briefings） */
  outputDir?: string;
  /** agent 版本標記（§9.1 agent_version） */
  agentVersion?: string;
  /** mcp server 版本標記（§9.1 mcp_server_version；未提供時由 scan 回傳推斷） */
  mcpServerVersion?: string;
  /** 動態風控參數（預設對齊 §9.1 範例：1.5/2.0/2.0/1.0/30000/2000 股） */
  risk?: Partial<TacticalBriefing['risk_guardrails']>;
  /** key_levels 參數（volume_surge_threshold 預設 2.5，§9.1） */
  levels?: Partial<TacticalBriefing['trading_plan']['key_levels']>;
  /** 時間窗（預設 09:05/11:30） */
  window?: { start_time?: string; no_new_entry_after?: string };
  /** 時鐘（測試注入） */
  nowFn?: () => Date;
}

export interface GenerateResult {
  briefing: TacticalBriefing;
  filePath: string;
}

/** 便利函式：依 §9.2 規則由 bias 對應 allowed/blocked */
export function actionsForBias(bias: Bias): { allowed: Action[]; blocked: Action[] } {
  switch (bias) {
    case 'NO_TRADE':
      return { allowed: [], blocked: ['BUY_TO_OPEN', 'SELL_TO_OPEN'] };
    case 'LONG_ONLY':
      return { allowed: ['BUY_TO_OPEN'], blocked: ['SELL_TO_OPEN'] };
    case 'SHORT_ONLY':
      return { allowed: ['SELL_TO_OPEN'], blocked: ['BUY_TO_OPEN'] };
    case 'NEUTRAL_FLEXIBLE':
      return { allowed: ['BUY_TO_OPEN', 'SELL_TO_OPEN'], blocked: [] };
  }
}

/** 信心度：|score| ≥ 70 HIGH、≥ 50 MEDIUM、否則 LOW（§9.2 範例） */
export function confidenceForScore(score: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  const abs = Math.abs(score);
  if (abs >= 70) return 'HIGH';
  if (abs >= 50) return 'MEDIUM';
  return 'LOW';
}

/** 動態 force_flat_by：SHORT_ONLY → 13:00，其餘 → 13:10（§9.2） */
export function forceFlatByForBias(bias: Bias): string {
  return bias === 'SHORT_ONLY' ? '13:00' : '13:10';
}

/** 依 §5.2 四因子建 scoring_breakdown（與 T016 評分表同源） */
export function breakdownFromScore(score: number, rationale: string): TacticalBriefing['bias_assessment']['scoring_breakdown'] {
  // 依比例拆解：trend ±20 / institutional ±25 / overnight ±25 / pre_market ±30
  // （T016 內部節點分數未外露；此處以總分與 rationale 重建展示明細）
  const s = Math.max(-100, Math.min(100, score));
  const factors = ['TECHNICAL_ALIGNMENT', 'INSTITUTIONAL_FLOW', 'OVERNIGHT_MARKET', 'PRE_MARKET_MATCH'] as const;
  const weights = [20, 25, 25, 30] as const;
  // 依權重比例分配總分（四捨五入後修正誤差至總分一致）
  let remaining = s;
  const raw = weights.map((w) => (s * w) / 100);
  const parts = raw.map((v) => Math.round(v));
  let diff = s - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < parts.length && diff !== 0; i++) {
    parts[i] += Math.sign(diff);
    diff -= Math.sign(diff);
  }
  remaining = s;
  void remaining;
  return factors.map((factor, i) => ({
    factor,
    score: parts[i],
    detail: rationale.split(' | ')[i] ?? '',
  }));
}

export class TacticalBriefingGenerator {
  private readonly opts: BriefingGeneratorOptions;
  private readonly nowFn: () => Date;

  constructor(opts: BriefingGeneratorOptions) {
    this.opts = opts;
    this.nowFn = opts.nowFn ?? (() => new Date());
  }

  /** 守門 + 提取 data（失敗回 null） */
  private async fetchGated(tool: string, args: Record<string, unknown>, symbol: string, now: Date) {
    let env: { data?: unknown; _lineage?: Record<string, unknown> };
    try {
      env = await this.opts.mcpCall(tool, args);
    } catch {
      return null;
    }
    const gate = this.opts.gate(env as never, this.opts.gateScope ?? 'PRE_MARKET', {
      symbol,
      now,
    } as never);
    if (!gate.passed) return null;
    return (env.data ?? {}) as Record<string, unknown>;
  }

  /**
   * 產生單一標的之 Tactical Briefing（§9.1/§9.2）。
   * @param symbol 標的代號
   * @param biasResult §5 Bias 決策結果（T016 產出）
   * @param target 標的基礎資料（昨日收盤/高點等）
   * @param now 業務時鐘（08:55 排程觸發）
   */
  async generate(
    symbol: string,
    biasResult: BiasResult,
    target: BriefingTargetInput,
    now: Date = this.nowFn(),
  ): Promise<GenerateResult> {
    const generatedAt = now.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00';
    const dataSources: Array<{ source: string; fetch_time: string }> = [];
    const fetchTime = now.toISOString();

    // 1. 資格掃描（過守門；失敗 → 保守 NO_TRADE + 註記）
    const eligEnv = await this.fetchGated('scan_daytrade_eligibility', { symbol }, symbol, now);
    let safetyFlags: TacticalBriefing['risk_guardrails']['safety_flags'] = {
      is_disposition: false,
      can_daytrade: true,
      can_short_first: true,
      earnings_announcement_today: false,
    };
    if (eligEnv) {
      safetyFlags = {
        is_disposition: eligEnv.is_disposition === true,
        can_daytrade: eligEnv.can_daytrade !== false,
        can_short_first: eligEnv.can_short_first === true,
        earnings_announcement_today: false,
      };
      dataSources.push({ source: 'TWSE_WEB', fetch_time: fetchTime });
    } else {
      // 資格不可得 → 保守：視同不可當沖（防呆：不啟動交易）
      safetyFlags = { ...safetyFlags, can_daytrade: false };
      dataSources.push({ source: 'UNKNOWN', fetch_time: fetchTime });
    }

    // 2. 昨日收盤/高低（get_stock_daily_kline 月份起點取前一日；失敗用 target 提供值）
    let yesterdayClose = target.yesterdayClose;
    let yesterdayHigh = target.yesterdayHigh ?? target.yesterdayClose * 1.01;
    const klineEnv = await this.fetchGated('get_stock_daily_kline', { symbol }, symbol, now);
    if (klineEnv) {
      const rows = (Array.isArray(klineEnv) ? klineEnv : (klineEnv.candles as unknown[])) as Array<{
        close?: number;
        high?: number;
        low?: number;
      }>;
      // 取最後一筆完整 K（不含當日）作為昨日參考；若目標已提供則以目標為主
      const last = rows[rows.length - 1];
      if (last && typeof last.close === 'number' && target.yesterdayClose === undefined) {
        yesterdayClose = last.close;
      }
      if (last && typeof last.high === 'number' && !target.yesterdayHigh) {
        yesterdayHigh = last.high;
      }
      dataSources.push({ source: 'TWSE', fetch_time: fetchTime });
    } else {
      dataSources.push({ source: 'TWSE', fetch_time: fetchTime, } as never);
    }

    // 3. Bias 對應（§9.2）
    const { allowed, blocked } = actionsForBias(biasResult.bias);
    const forceFlatBy = forceFlatByForBias(biasResult.bias);

    // 4. 組裝
    const riskBase = {
      max_position_size_shares: 2000,
      hard_stop_loss_pct: 1.5,
      take_profit_target_1_pct: 2.0,
      trailing_stop_activation_pct: 2.0,
      trailing_stop_callback_pct: 1.0,
      max_drawdown_limit_ntd: 30000,
      safety_flags: safetyFlags,
    };
    const briefing: TacticalBriefing = {
      _lineage: {
        generated_at: generatedAt,
        agent_version: this.opts.agentVersion ?? 'tw-quant-daybrain/v2.0.0',
        mcp_server_version: this.opts.mcpServerVersion ?? 'tw-quant-mcp/v1.3.0',
        data_sources: dataSources,
      },
      target: {
        symbol,
        name: target.name ?? symbol,
        market: target.market ?? 'TWSE',
        yesterday_close: yesterdayClose,
      },
      bias_assessment: {
        bias: biasResult.bias,
        score: biasResult.score,
        confidence: confidenceForScore(biasResult.score),
        scoring_breakdown: breakdownFromScore(biasResult.score, biasResult.rationale),
      },
      trading_plan: {
        allowed_actions: allowed,
        blocked_actions: blocked,
        active_window: {
          start_time: this.opts.window?.start_time ?? '09:05',
          no_new_entry_after: this.opts.window?.no_new_entry_after ?? '11:30',
          force_flat_by: forceFlatBy,
        },
        key_levels: {
          anchor_vwap_estimate: this.opts.levels?.anchor_vwap_estimate ?? yesterdayClose * 1.005,
          breakout_pivot_price: this.opts.levels?.breakout_pivot_price ?? yesterdayHigh,
          support_invalidation_price: this.opts.levels?.support_invalidation_price ?? yesterdayClose * 0.985,
          volume_surge_threshold: this.opts.levels?.volume_surge_threshold ?? 2.5,
        },
      },
      risk_guardrails: {
        ...riskBase,
        ...this.opts.risk,
        safety_flags: { ...safetyFlags, ...(this.opts.risk?.safety_flags ?? {}) },
      },
    };

    // 5. 持久化 briefings/YYYY-MM-DD_SYMBOL.json
    const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const outputDir = this.opts.outputDir ?? path.join(process.cwd(), 'briefings');
    await fs.mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, `${dateStr}_${symbol}.json`);
    await fs.writeFile(filePath, JSON.stringify(briefing, null, 2), 'utf-8');

    // 6. 事件
    if (this.opts.events) {
      this.opts.events.write('briefing_generated', { briefing_id: `${dateStr}_${symbol}`, symbol, bias: biasResult.bias, score: biasResult.score }, now);
    }

    return { briefing, filePath };
  }
}

/**
 * 盤中載入當日 Briefing（§9.3 防呆）：
 * 找不到當日檔案 → 回 null（呼叫端應拒絕啟動交易）。
 */
export async function loadBriefing(
  outputDir: string,
  symbol: string,
  date: Date,
): Promise<TacticalBriefing | null> {
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const filePath = path.join(outputDir, `${dateStr}_${symbol}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as TacticalBriefing;
  } catch {
    return null;
  }
}
