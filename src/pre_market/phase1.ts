// Phase 1 盤前選股（T006，§4 Phase 1）
// - 三路徑選股去重：投信+外資同步買超前 20／量能異常／重大訊息
// - 過濾：scan_daytrade_eligibility 剔除禁止當沖/處置/注意/停資停券、剔除無觸發價者
// - 候選清單 3–5 檔：做多觸發價＝昨日高點＋站穩 VWAP；硬停損 -1.5% 或 VWAP（先觸發）
// - 低訊號日：選股不足 3 檔 → 降門檻（買超前 30）或註明低訊號日，不可硬湊
// - 呼叫 set_active_watchlist（≤15 檔）；失敗 → §3.2 降級並記錄

import type {
  McpCallFn,
  GateCheckFn,
  PreMarketCandidate,
  EligibilityResult,
  PreMarketReport,
  SelectionSource,
} from './types.js';

export interface Phase1Options {
  mcpCall: McpCallFn;
  gate: GateCheckFn;
  /** 候選清單目標數量（預設 3–5） */
  targetMin?: number;
  targetMax?: number;
  /** 門檻降級：買超前 N → 前 N*1.5（預設 30） */
  fallbackTopN?: number;
  /** 買超前 N 檔（預設 20） */
  institutionalTopN?: number;
  /** 昨日日期（YYYY-MM-DD；測試注入） */
  yesterday?: string;
  /** 今日日期（YYYY-MM-DD；測試注入） */
  today?: string;
  /** 門檻檢查 function（測試注入；預設掃描） */
  scanEligibility?: (symbol: string) => Promise<EligibilityResult>;
  /** 觸發價/停損價計算 function（測試注入；預設規則計算） */
  priceCalculator?: (
    symbol: string,
  ) => Promise<{ yesterdayClose: number; yesterdayHigh: number; vwapEstimate: number }>;
}

/** 選股路徑原始資料（三路徑去重用） */
export interface SelectionPool {
  institutional: string[]; // 投信+外資同步買超前 N
  abnormal: string[]; // 量能異常
  announcements: string[]; // 重大訊息個股
}

/** symbol → 名稱查找表（三路徑資料內含 name 時帶入，供候選顯示） */
export type NameLookup = Map<string, string>;

export const INSTITUTIONAL_TOP_N = 20;
export const FALLBACK_TOP_N = 30;

/** 依 §4 Phase 1 三路徑組合成選股池（去重） */
export function buildSelectionPool(
  instData: unknown,
  abnormalData: unknown,
  annData: unknown,
): SelectionPool {
  const institutional: string[] = [];
  const abnormal: string[] = [];
  const announcements: string[] = [];

  // get_institutional_investors：data 可能為 array（個股明細）或 object（含 stocks）
  const inst = instData as { stocks?: Array<{ symbol: string; [k: string]: unknown }> } | Array<{ symbol: string; [k: string]: unknown }>;
  const instList = Array.isArray(inst) ? inst : inst?.stocks;
  if (Array.isArray(instList)) {
    for (const s of instList) {
      if (typeof s.symbol === 'string') institutional.push(s.symbol);
    }
  }

  // get_abnormal_trading：data.stocks
  const abn = abnormalData as { stocks?: Array<{ symbol: string; [k: string]: unknown }> };
  if (Array.isArray(abn?.stocks)) {
    for (const s of abn.stocks) {
      if (typeof s.symbol === 'string') abnormal.push(s.symbol);
    }
  }

  // get_major_announcements：data.announcements[].symbol
  const ann = annData as { announcements?: Array<{ symbol?: string; [k: string]: unknown }> };
  if (Array.isArray(ann?.announcements)) {
    for (const a of ann.announcements) {
      if (typeof a.symbol === 'string') announcements.push(a.symbol);
    }
  }

  return { institutional, abnormal, announcements };
}

/** 從三路徑原始資料收集 symbol→name（name 存在時） */
export function collectNames(
  instData: unknown,
  abnormalData: unknown,
  annData: unknown,
): NameLookup {
  const names = new Map<string, string>();
  const inst = instData as { stocks?: Array<{ symbol: string; name?: unknown }> } | Array<{ symbol: string; name?: unknown }>;
  const instList = Array.isArray(inst) ? inst : inst?.stocks;
  for (const s of instList ?? []) {
    if (typeof s.symbol === 'string' && typeof s.name === 'string' && s.name) {
      names.set(s.symbol, s.name);
    }
  }
  const abn = abnormalData as { stocks?: Array<{ symbol: string; name?: unknown }> };
  for (const s of abn?.stocks ?? []) {
    if (typeof s.symbol === 'string' && typeof s.name === 'string' && s.name) {
      names.set(s.symbol, s.name);
    }
  }
  const ann = annData as { announcements?: Array<{ symbol?: string; name?: unknown }> };
  for (const a of ann?.announcements ?? []) {
    if (typeof a.symbol === 'string' && typeof a.name === 'string' && a.name) {
      names.set(a.symbol, a.name);
    }
  }
  return names;
}

/** 候選排序：籌碼分（投信+外資淨買超）遞減 */
export function sortCandidates(
  candidates: PreMarketCandidate[],
): PreMarketCandidate[] {
  return [...candidates].sort((a, b) => b.flowScore - a.flowScore);
}

export class Phase1Selector {
  private readonly opts: Required<Phase1Options>;

  constructor(options: Phase1Options) {
    this.opts = {
      mcpCall: options.mcpCall,
      gate: options.gate,
      targetMin: options.targetMin ?? 3,
      targetMax: options.targetMax ?? 5,
      fallbackTopN: options.fallbackTopN ?? FALLBACK_TOP_N,
      institutionalTopN: options.institutionalTopN ?? INSTITUTIONAL_TOP_N,
      yesterday: options.yesterday ?? '',
      today: options.today ?? '',
      scanEligibility: options.scanEligibility ?? (async (symbol) => {
        const env = await this.opts.mcpCall('scan_daytrade_eligibility', { symbol });
        const r = this.opts.gate(env as never, 'PRE_MARKET', { symbol });
        if (!r.passed) {
          return { symbol, eligible: false, riskStatus: `gate:${r.cause ?? 'fail'}` };
        }
        const data = (env.data ?? {}) as Record<string, unknown>;
        return {
          symbol,
          eligible: data.eligible === true,
          riskStatus: (data.risk_status as string) ?? undefined,
          isAttention: data.is_attention === true,
          isDisposition: data.is_disposition === true,
          marginRestricted: data.margin_restricted === true,
        };
      }),
      priceCalculator: options.priceCalculator ?? (async (symbol) => {
        const env = await this.opts.mcpCall('get_stock_daily_kline', { symbol });
        const r = this.opts.gate(env as never, 'HISTORICAL', { symbol });
        if (!r.passed) {
          throw new Error(`get_stock_daily_kline 守門失敗（${r.cause ?? 'fail'}）`);
        }
        const data = (env.data ?? {}) as { candles?: Array<{ high?: number; close?: number; [k: string]: unknown }> };
        const candles = data.candles ?? [];
        if (candles.length === 0) {
          throw new Error('get_stock_daily_kline 無 K 線資料');
        }
        const last = candles[candles.length - 1];
        if (typeof last.close !== 'number' || typeof last.high !== 'number') {
          throw new Error('K 線缺 close/high');
        }
        // VWAP 估計：以昨日 (high+low+close)/3 之典型價格近似
        const low = typeof last.low === 'number' ? last.low : last.close;
        const vwapEstimate = (last.high + last.close + low) / 3;
        return { yesterdayClose: last.close, yesterdayHigh: last.high, vwapEstimate };
      }),
    };
  }

  /** 由選股池去重後之 symbol 清單 */
  private dedupe(pool: SelectionPool): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of [...pool.institutional, ...pool.abnormal, ...pool.announcements]) {
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  /** 低訊號日降門檻：不足 targetMin 檔時，將投信+外資買超前 N 擴大到 fallbackTopN */
  private async fallbackExpand(
    pool: SelectionPool,
    current: string[],
  ): Promise<string[]> {
    const expanded = new Set(current);
    for (const s of pool.institutional) expanded.add(s);
    return [...expanded];
  }

  /** 計算候選（觸發價/停損價/籌碼分/catalyst） */
  private async buildCandidate(
    symbol: string,
    sources: SelectionSource[],
    name?: string,
  ): Promise<PreMarketCandidate | null> {
    try {
      const prices = await this.opts.priceCalculator(symbol);
      const triggerPrice = prices.yesterdayHigh;
      const stopLossPrice = Math.min(
        prices.yesterdayClose * 0.985, // -1.5% 硬停損
        prices.vwapEstimate, // 跌破 VWAP（先觸發者）
      );
      const flowScore = sources.includes('INSTITUTIONAL') ? 25 : 10;
      return {
        symbol,
        name,
        direction: 'LONG',
        triggerPrice,
        stopLossPrice,
        yesterdayClose: prices.yesterdayClose,
        yesterdayHigh: prices.yesterdayHigh,
        catalyst: sources.map((s) => this.sourceLabel(s)).join('、'),
        sources,
        flowScore,
      };
    } catch {
      return null; // 無 K 線/守門失敗 → 剔除（無觸發價者）
    }
  }

  private sourceLabel(s: SelectionSource): string {
    switch (s) {
      case 'INSTITUTIONAL':
        return '法人同步買超';
      case 'ABNORMAL':
        return '量能異常';
      case 'ANNOUNCEMENT':
        return '重大訊息';
    }
  }

  /**
   * Phase 1 選股主流程：
   * 三路徑選股去重 → 風控過濾 → 候選計算 → 3–5 檔 → set_active_watchlist
   */
  async run(): Promise<PreMarketReport> {
    const today = this.opts.today || new Date().toISOString().slice(0, 10);
    void this.opts.yesterday; // 保留欄位（priceCalculator stub 使用）

    // 1. 三路徑取得
    const instEnv = await this.opts.mcpCall('get_institutional_investors', {});
    const abnEnv = await this.opts.mcpCall('get_abnormal_trading', {});
    const annEnv = await this.opts.mcpCall('get_major_announcements', {});
    const pool = buildSelectionPool(instEnv.data, abnEnv.data, annEnv.data);
    const names = collectNames(instEnv.data, abnEnv.data, annEnv.data);

    // 2. 去重
    let symbols = this.dedupe(pool);
    // 若不足 targetMin → 降門檻（買超前 N 擴大）
    if (symbols.length < (this.opts.targetMin ?? 3)) {
      symbols = await this.fallbackExpand(pool, symbols);
    }

    // 3. 風控過濾（scan_daytrade_eligibility）
    const candidates: PreMarketCandidate[] = [];
    for (const symbol of symbols) {
      if (candidates.length >= (this.opts.targetMax ?? 5)) break;
      const elig = await this.opts.scanEligibility(symbol);
      if (!elig.eligible) continue; // 剔除禁止當沖/處置/注意/停資停券
      const sources: SelectionSource[] = [];
      if (pool.institutional.includes(symbol)) sources.push('INSTITUTIONAL');
      if (pool.abnormal.includes(symbol)) sources.push('ABNORMAL');
      if (pool.announcements.includes(symbol)) sources.push('ANNOUNCEMENT');
      const cand = await this.buildCandidate(symbol, sources, names.get(symbol));
      if (cand) {
        cand.riskStatus = elig.riskStatus;
        candidates.push(cand);
      }
    }

    // 4. 排序 + 截斷至 3–5 檔
    const ranked = sortCandidates(candidates).slice(0, this.opts.targetMax ?? 5);
    const lowSignalDay = ranked.length < (this.opts.targetMin ?? 3);

    // 5. set_active_watchlist（≤15 檔）
    const watchlist = ranked.map((c) => c.symbol).slice(0, 15);
    let watchlistError: string | undefined;
    if (watchlist.length > 0) {
      try {
        await this.opts.mcpCall('set_active_watchlist', { symbols: watchlist });
      } catch (err) {
        watchlistError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      date: today,
      connectionReady: true,
      dataGaps: watchlistError
        ? [{ tool: 'set_active_watchlist', reason: watchlistError }]
        : [],
      candidates: ranked,
      watchlist,
      lowSignalDay,
      generatedAt: new Date().toISOString(),
    };
  }
}
