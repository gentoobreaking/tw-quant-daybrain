// Priority Ranking Engine（T020，§10 優先權排序與動態資金分配）
// - 多標的同時觸發時依 Rank Score 排隊派單；Tier 資金上限、產業集中度 40% 限制、資金池風控
// - 綜合優先權得分（§10.1）：R = 0.4×S_pre + 0.5×M_surge − 0.1×D_vwap
//     S_pre：Briefing 得分（0~100）；M_surge：爆量倍數封頂 100（5 倍×20）；D_vwap：VWAP 偏離扣分（%×15）
//     權重可經回測調參（§13）
// - 三層流程（§10.1）：第一層盤前戰術評級（白名單 + Tier）→ 第二層盤中即時動能（Rank Score）→
//   第三層資金池風控配額（總曝光/族群 40%/1 張最低門檻）
// - Tier 資金配置（§10.2，資金池 300 萬、槓桿 2 倍總曝光 600 萬）：
//     S_pre≥80 → 33%（200 萬）、60–80 → 20%（120 萬）、50–60 → 10%（60 萬）、<50 → 禁止
// - 產業集中度（§10.2）：同族群在手持倉 ≤ 總曝光 40%（SECTOR_LIMIT_PCT）
// - 白名單過濾（§10.3）：allowed_actions 不含該 action → 直接拒絕
// - 競爭搶單（§10.4）：同 tick 多訊號依 Rank Score 排序依序派單；資金不足 1 張 → 拒絕
// - API 對齊 §10.3：evaluateSignal(candidate, briefing, sector) / registerPosition / releasePosition；
//   另提供 rank()（T009 PriorityEngine 接口）排序 signal_id
// - 決策寫 priority_ranked 事件（T004：candidates 必填；含 rankScore/allocatedCapital/reason）
// - 環境變數參數化（§17.1）：TOTAL_MARGIN_POOL_NTD / MAX_LEVERAGE / SECTOR_LIMIT_PCT / MAX_POSITIONS

import type { TacticalBriefing } from '../briefing/generator.js';
import type { EventLogger } from '../logging/event_logger.js';

export type PriorityAction = 'BUY_TO_OPEN' | 'SELL_TO_OPEN';

/** §10.3 SignalCandidate */
export interface SignalCandidate {
  symbol: string;
  action: PriorityAction;
  price: number;
  /** 盤中爆量倍數（如 3.5 = 3.5 倍） */
  volumeSurgeRatio: number;
  /** 偏離 VWAP %（如 0.8 = 0.8%；正=追高） */
  vwapDeviationPct: number;
  /** 訊號分數（Signal Scoring 產出；0~100） */
  signalScore?: number;
  timestamp?: string;
}

/** §10.3 ExecutionDecision */
export interface ExecutionDecision {
  shouldExecute: boolean;
  symbol: string;
  rankScore: number;
  allocatedCapitalNtd: number;
  reason: string;
}

/** 已註冊持倉（資金 + 族群） */
export interface RegisteredPosition {
  capital: number;
  sector: string;
}

export interface PriorityEngineOptions {
  events?: EventLogger;
  /** 資金池 NT$（§17.1 TOTAL_MARGIN_POOL_NTD，預設 3,000,000） */
  totalMarginPoolNtd?: number;
  /** 最大槓桿（§17.1 MAX_LEVERAGE，預設 2.0） */
  maxLeverage?: number;
  /** 最大同時持倉檔數（§17.1 MAX_POSITIONS，預設 2） */
  maxPositions?: number;
  /** 族群集中度上限（§17.1 SECTOR_LIMIT_PCT，預設 0.40） */
  sectorLimitPct?: number;
  /** Rank 權重（§10.1，可經 §13 回測調參） */
  weights?: { wBias: number; wSurge: number; wDist: number };
  /** 爆量封頂（§10.3 5 倍 → 100 分） */
  surgeCap?: number;
  /** 每張股數（台股 1 張 = 1000 股；§10.3 用 price×1000 計算 1 張成本） */
  sharesPerLot?: number;
}

/** Tier 資金上限（§10.2） */
export function tierCapitalForScore(score: number, totalMarginPoolNtd: number): number {
  if (score >= 80) return totalMarginPoolNtd * 0.33; // Tier 1: 33%
  if (score >= 60) return totalMarginPoolNtd * 0.20; // Tier 2: 20%
  if (score >= 50) return totalMarginPoolNtd * 0.10; // Tier 3: 10%
  return 0; // Tier 4: 拒絕
}

/** 綜合優先權得分 R（§10.1） */
export function computeRankScore(
  preMarketScore: number,
  volumeSurgeRatio: number,
  vwapDeviationPct: number,
  weights: { wBias: number; wSurge: number; wDist: number } = { wBias: 0.4, wSurge: 0.5, wDist: 0.1 },
  surgeCap = 5,
): number {
  const surgeScore = Math.min(volumeSurgeRatio * 20, surgeCap * 20); // 爆量 5 倍封頂得 100 分
  const vwapPenalty = vwapDeviationPct * 15; // 偏離過高扣分
  return weights.wBias * preMarketScore + weights.wSurge * surgeScore - weights.wDist * vwapPenalty;
}

export class PriorityRankingEngine {
  private readonly opts: PriorityEngineOptions;
  private readonly totalMarginPoolNtd: number;
  private readonly maxPortfolioExposureNtd: number;
  private readonly maxPositions: number;
  private readonly sectorLimitPct: number;
  private readonly weights: { wBias: number; wSurge: number; wDist: number };
  private readonly surgeCap: number;
  private readonly sharesPerLot: number;
  private currentActivePositions: Map<string, RegisteredPosition> = new Map();

  constructor(opts: PriorityEngineOptions = {}) {
    this.opts = opts;
    this.totalMarginPoolNtd = opts.totalMarginPoolNtd ?? 3_000_000;
    this.maxPortfolioExposureNtd = this.totalMarginPoolNtd * (opts.maxLeverage ?? 2.0);
    this.maxPositions = opts.maxPositions ?? 2;
    this.sectorLimitPct = opts.sectorLimitPct ?? 0.4;
    this.weights = opts.weights ?? { wBias: 0.4, wSurge: 0.5, wDist: 0.1 };
    this.surgeCap = opts.surgeCap ?? 5;
    this.sharesPerLot = opts.sharesPerLot ?? 1000;
  }

  get activePositions(): Map<string, RegisteredPosition> {
    return this.currentActivePositions;
  }

  /**
   * §10.3 evaluateSignal：白名單 → 檔數上限 → 總曝光 → Rank Score → Tier 資金 → 族群 40% → 1 張門檻
   */
  public evaluateSignal(
    candidate: SignalCandidate,
    briefing: TacticalBriefing,
    symbolSector = 'ELECTRONICS',
  ): ExecutionDecision {
    // 1. 硬性白名單過濾（§10.3）
    if (!briefing.trading_plan.allowed_actions.includes(candidate.action)) {
      return this.decision(false, candidate.symbol, 0, 0,
        `Action ${candidate.action} 被 Briefing 阻擋 (Bias: ${briefing.bias_assessment.bias})`);
    }

    // 2. 持倉檔數上限（MAX_POSITIONS，v2.1）
    if (this.currentActivePositions.size >= this.maxPositions && !this.currentActivePositions.has(candidate.symbol)) {
      return this.decision(false, candidate.symbol, 0, 0,
        `已達最大同時持倉檔數上限 (MAX_POSITIONS=${this.maxPositions})`);
    }

    // 3. 檢查總持倉曝光上限
    const currentTotalExposure = this.totalExposure();
    if (currentTotalExposure >= this.maxPortfolioExposureNtd) {
      return this.decision(false, candidate.symbol, 0, 0, '已達全系統當沖最大總曝光上限 (Max Portfolio Exposure Reached)');
    }

    // 4. 綜合優先權得分（§10.1）
    const preMarketScore = briefing.bias_assessment.score;
    const rankScore = computeRankScore(
      preMarketScore,
      candidate.volumeSurgeRatio,
      candidate.vwapDeviationPct,
      this.weights,
      this.surgeCap,
    );

    // 5. Tier 資金上限（§10.2）
    const tierMaxCapital = tierCapitalForScore(preMarketScore, this.totalMarginPoolNtd);
    if (tierMaxCapital <= 0) {
      return this.decision(false, candidate.symbol, Number(rankScore.toFixed(2)), 0,
        `盤前評級 ${preMarketScore} < 50 → Tier 4 禁止交易`);
    }

    // 6. 產業集中度（§10.2：同族群 ≤ 總曝光 40%）
    const sectorExposure = Array.from(this.currentActivePositions.values())
      .filter((p) => p.sector === symbolSector)
      .reduce((sum, p) => sum + p.capital, 0);
    const maxAllowedSectorCapital = this.maxPortfolioExposureNtd * this.sectorLimitPct;
    const remainingSectorBudget = maxAllowedSectorCapital - sectorExposure;
    if (remainingSectorBudget <= 0) {
      return this.decision(false, candidate.symbol, Number(rankScore.toFixed(2)), 0,
        `同族群 (${symbolSector}) 額度已滿 (上限 ${Math.round(maxAllowedSectorCapital).toLocaleString()})`);
    }

    // 7. 最終可分配資金
    const availableSystemBudget = this.maxPortfolioExposureNtd - currentTotalExposure;
    const finalAllocatedCapital = Math.min(tierMaxCapital, remainingSectorBudget, availableSystemBudget);

    // 8. 1 張門檻（§10.4：資金不足 1 張 → 拒絕）
    const oneLotCost = candidate.price * this.sharesPerLot;
    if (finalAllocatedCapital < oneLotCost) {
      return this.decision(false, candidate.symbol, Number(rankScore.toFixed(2)), 0,
        `剩餘配額 NT$ ${Math.floor(finalAllocatedCapital).toLocaleString()} 不足以買進 1 張 (NT$ ${Math.floor(oneLotCost).toLocaleString()})`);
    }

    return this.decision(true, candidate.symbol, Number(rankScore.toFixed(2)), Math.floor(finalAllocatedCapital),
      `優先權評分通過 (${rankScore.toFixed(1)}分)，核准資金 NT$ ${Math.floor(finalAllocatedCapital).toLocaleString()}`);
  }

  /** 註冊持倉（§10.3；evaluateSignal 通過後由執行層呼叫） */
  public registerPosition(symbol: string, capital: number, sector: string): void {
    this.currentActivePositions.set(symbol, { capital, sector });
  }

  /** 釋放持倉（§10.3；平倉後由執行層呼叫） */
  public releasePosition(symbol: string): void {
    this.currentActivePositions.delete(symbol);
  }

  /** 當前總曝光 */
  public totalExposure(): number {
    return Array.from(this.currentActivePositions.values()).reduce((sum, p) => sum + p.capital, 0);
  }

  /**
   * T009 PriorityEngine 接口：同 tick 多檔觸發 → 依 Rank Score 排序回傳 signal_id 清單。
   * @param candidates 同 tick 觸發之訊號（signal_id/symbol/score + 可選爆量/偏離）
   */
  public async rank(
    candidates: Array<{
      signal_id: string;
      symbol: string;
      score: number;
      volumeSurgeRatio?: number;
      vwapDeviationPct?: number;
    }>,
  ): Promise<string[]> {
    const scored = candidates.map((c) => {
      const rankScore = computeRankScore(
        c.score,
        c.volumeSurgeRatio ?? 1,
        c.vwapDeviationPct ?? 0,
        this.weights,
        this.surgeCap,
      );
      return { id: c.signal_id, symbol: c.symbol, rankScore };
    });
    scored.sort((a, b) => b.rankScore - a.rankScore);
    if (this.opts.events) {
      this.opts.events.write('priority_ranked', {
        candidates: scored.map((s) => ({ signal_id: s.id, symbol: s.symbol, rankScore: Number(s.rankScore.toFixed(2)) })),
      });
    }
    return scored.map((s) => s.id);
  }

  private decision(
    shouldExecute: boolean,
    symbol: string,
    rankScore: number,
    allocatedCapitalNtd: number,
    reason: string,
  ): ExecutionDecision {
    if (this.opts.events) {
      this.opts.events.write('priority_ranked', {
        candidates: [{ symbol, shouldExecute, rankScore, allocatedCapitalNtd, reason }],
      });
    }
    return { shouldExecute, symbol, rankScore, allocatedCapitalNtd, reason };
  }
}
