// 事件驅動回測模擬器（T022，§12 事件驅動市場重放）
// - 四步驟架構（§12.1）：Step1 盤前重放（前 3 日 + 試撮 → briefing）→ Step2 盤中時間軸 Loop（每分鐘廣播、
//   算 VWAP/Surge/突破）→ Step3 Priority Engine 競態排隊與撮合（Rank Score + Tier + 族群 40% + 滑點/稅費）→
//   Step4 持倉追蹤與強制平倉（停損/停利/強平，平倉釋放資金池）
// - 資料契約（§12.2）：MinuteBar / TradeRecord / ActivePosition（自 types.ts 共用）
// - 觸發條件讀取 Briefing（§12.4）：volume_surge_threshold（預設 2.5）、時間窗 start_time/no_new_entry_after
//   自 trading_plan 載入；forceFlatBy 多空不同（SHORT_ONLY → 13:00，其餘 13:10，§7.4/§11.5）
// - 成本設定（§12.4）：手續費 0.001425×0.28（2.8 折）、當沖證交稅 0.0015、滑點 1 檔（買進 ×1.0005）
// - 離場檢查（§12.4）：STOP_LOSS / TAKE_PROFIT（R:R≥2:1）/ TRAILING_STOP / FORCE_FLAT
// - Priority Engine 注入（§12.1 Step3）：同分鐘多候選依 Rank Score 排序、Tier 與族群 40% 上限、資金不足 1 張拒絕
// - 回測報告（§12.5）：summary（total_trades/win_rate/net_total_pnl/profit_factor/max_drawdown）+
//   engine_effectiveness（blocked_by_briefing_bias/blocked_by_sector_limit/blocked_by_margin_cap/
//   priority_ranking_conflicts_resolved）+ trades
// - 每迭代實例化全新 Simulator 清空狀態（§13.1 Grid Search 需求）

import {
  PriorityRankingEngine,
  type SignalCandidate,
} from '../execution/priority_engine.js';
import type { TacticalBriefing } from '../briefing/generator.js';
import type { MinuteBar, TradeRecord, ActivePosition } from './types.js';

export type { MinuteBar, TradeRecord, ActivePosition } from './types.js';

export type ExitReason = TradeRecord['exitReason'];

/** §12.5 回測報告 */
export interface BacktestReport {
  summary: {
    test_period: string;
    total_simulated_days: number;
    total_trades: number;
    win_rate_pct: number;
    net_total_pnl_ntd: number;
    profit_factor: number;
    max_drawdown_ntd: number;
  };
  engine_effectiveness: {
    blocked_by_briefing_bias: number;
    blocked_by_sector_limit: number;
    blocked_by_margin_cap: number;
    priority_ranking_conflicts_resolved: number;
  };
  trades: TradeRecord[];
}

export interface BacktestSimulatorOptions {
  totalMarginPoolNtd?: number;
  maxLeverage?: number;
  maxPositions?: number;
  sectorLimitPct?: number;
  /** 滑點倍率（買進 ×1.0005，§12.4 1 檔） */
  slippageMultiplier?: number;
  commissionRate?: number;
  daytradeTaxRate?: number;
  /** 族群（預設 ELECTRONICS，§12.4 範例） */
  sector?: string;
  /** Priority Engine（可注入；預設內部實例化） */
  rankingEngine?: PriorityRankingEngine;
}

const DEFAULT_COMMISSION_RATE = 0.001425 * 0.28; // 券商手續費 2.8 折
const DEFAULT_DAYTRADE_TAX_RATE = 0.0015; // 當沖證交稅減半 1.5‰
const DEFAULT_SLIPPAGE_MULTIPLIER = 1.0005; // 1 檔跳動

/** 依時間戳取 HH:MM（ISO +08:00） */
export function timeOnlyOf(isoDatetime: string): string {
  return isoDatetime.split('T')[1].substring(0, 5);
}

export class DayBrainBacktestSimulator {
  private rankingEngine: PriorityRankingEngine;
  private briefings: Map<string, TacticalBriefing> = new Map();
  private activePositions: Map<string, ActivePosition> = new Map();
  private completedTrades: TradeRecord[] = [];

  // 成本設定（台灣股市，§12.4）
  private readonly commissionRate: number;
  private readonly daytradeTaxRate: number;
  private readonly slippageMultiplier: number;
  private readonly sector: string;

  // engine_effectiveness 計數
  private blockedByBriefingBias = 0;
  private blockedBySectorLimit = 0;
  private blockedByMarginCap = 0;
  private conflictsResolved = 0;

  private tradeCounter = 0;

  constructor(opts: BacktestSimulatorOptions = {}) {
    this.rankingEngine =
      opts.rankingEngine ??
      new PriorityRankingEngine({
        totalMarginPoolNtd: opts.totalMarginPoolNtd ?? 3_000_000,
        maxLeverage: opts.maxLeverage ?? 2.0,
        maxPositions: opts.maxPositions ?? 2,
        sectorLimitPct: opts.sectorLimitPct ?? 0.4,
      });
    this.commissionRate = opts.commissionRate ?? DEFAULT_COMMISSION_RATE;
    this.daytradeTaxRate = opts.daytradeTaxRate ?? DEFAULT_DAYTRADE_TAX_RATE;
    this.slippageMultiplier = opts.slippageMultiplier ?? DEFAULT_SLIPPAGE_MULTIPLIER;
    this.sector = opts.sector ?? 'ELECTRONICS';
  }

  public loadBriefings(briefingList: TacticalBriefing[]): void {
    briefingList.forEach((b) => this.briefings.set(b.target.symbol, b));
  }

  /** 測試用：已平倉交易筆數 */
  public getCompletedTradesCount(): number {
    return this.completedTrades.length;
  }

  /** 每迭代全新實例（§13.1）——由呼叫端 new 即可；此為明確化語意 */
  public reset(): void {
    this.activePositions.clear();
    this.completedTrades = [];
    this.blockedByBriefingBias = 0;
    this.blockedBySectorLimit = 0;
    this.blockedByMarginCap = 0;
    this.conflictsResolved = 0;
    this.tradeCounter = 0;
  }

  public runSimulation(marketData: Map<string, MinuteBar[]>): BacktestReport {
    // §13.1 多日 fixtures：依交易日切分，每日獨立模擬（runningStats/持倉/計數器重置），最後合併
    const days = this.splitByTradingDay(marketData);
    if (days.length > 0) {
      const reports: BacktestReport[] = [];
      for (const day of days) {
        reports.push(this.runSingleDay(day.marketData));
        // 跨日重置：持倉與 Priority Engine 註冊狀態
        this.activePositions.clear();
        this.rankingEngine.releaseAllPositions();
        this.conflictsResolved = 0;
        this.blockedByBriefingBias = 0;
        this.blockedBySectorLimit = 0;
        this.blockedByMarginCap = 0;
      }
      // 合併報告
      return this.mergeDayReports(reports, days[0].date, days[days.length - 1].date);
    }
    return this.runSingleDay(marketData);
  }

  private runSingleDay(marketData: Map<string, MinuteBar[]>): BacktestReport {
    const timestamps = this.extractAndSortTimestamps(marketData);

    // 每標的滾動統計：VWAP 累計 / 當日高低 / 開盤 15 分低點（凍結）/ 近 20 分鐘量
    const runningStats = new Map<
      string,
      { vwapVolumeSum: number; vwapValueSum: number; dayHigh: number; dayLow: number; first15mLow: number; volumes: number[] }
    >();
    for (const symbol of marketData.keys()) {
      runningStats.set(symbol, { vwapVolumeSum: 0, vwapValueSum: 0, dayHigh: 0, dayLow: Infinity, first15mLow: Infinity, volumes: [] });
    }

    for (const timeStr of timestamps) {
      const timeOnly = timeOnlyOf(timeStr);
      const candidatesThisMinute: SignalCandidate[] = [];

      // A. 先檢查並更新現有持倉（停損/停利/強平）——先離場後進場，避免同分鐘新訊號與舊倉混淆
      for (const [symbol, pos] of Array.from(this.activePositions.entries())) {
        const bars = marketData.get(symbol);
        const currentBar = bars?.find((b) => b.datetime === timeStr);
        if (currentBar) this.checkExitConditions(pos, currentBar, timeOnly);
      }

      // B. 處理各標的的新 K 線並評估訊號（§12.1 Step2）
      for (const [symbol, bars] of marketData.entries()) {
        const currentBar = bars.find((b) => b.datetime === timeStr);
        if (!currentBar) continue;

        const stats = runningStats.get(symbol)!;
        stats.vwapVolumeSum += currentBar.volume;
        stats.vwapValueSum += currentBar.close * currentBar.volume;
        stats.dayHigh = Math.max(stats.dayHigh, currentBar.high);
        stats.dayLow = Math.min(stats.dayLow, currentBar.low);
        // §7.2 條件 3 基準：開盤前 15 分鐘低點（09:15 前凍結）
        if (timeOnly <= '09:15') {
          stats.first15mLow = Math.min(stats.first15mLow, currentBar.low);
        }
        stats.volumes.push(currentBar.volume);

        const currentVwap = stats.vwapValueSum / (stats.vwapVolumeSum || 1);
        const briefing = this.briefings.get(symbol);
        if (!briefing || this.activePositions.has(symbol)) continue;

        // 時間窗口檢查（§12.4：start_time ~ no_new_entry_after）
        if (timeOnly < briefing.trading_plan.active_window.start_time || timeOnly > briefing.trading_plan.active_window.no_new_entry_after) {
          continue;
        }

        // 1 分鐘爆量倍數（近 20 分鐘均量，§12.4）
        const recentVolumes = stats.volumes.slice(-21, -1);
        const avgVolume = recentVolumes.length > 0
          ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length
          : currentBar.volume;
        const surgeRatio = currentBar.volume / (avgVolume || 1);
        const surgeThreshold = briefing.trading_plan.key_levels.volume_surge_threshold ?? 2.5;
        const vwapDeviationPct = Number((((currentBar.close - currentVwap) / currentVwap) * 100).toFixed(2));

        // 觸發多方條件：突破 VWAP + 爆量 ≥ threshold + 逼近當日高點（Briefing 白名單由 Priority Engine 在 Step3 攔截，§12.1）
        if (
          currentBar.close > currentVwap &&
          surgeRatio >= surgeThreshold &&
          currentBar.close >= stats.dayHigh * 0.998
        ) {
          candidatesThisMinute.push({
            symbol,
            action: 'BUY_TO_OPEN',
            price: currentBar.close,
            volumeSurgeRatio: Number(surgeRatio.toFixed(2)),
            vwapDeviationPct,
            timestamp: timeStr,
          });
        }
        // 觸發空方條件：跌破 VWAP + 爆量 ≥ threshold + 跌破開盤前 15 分鐘低點（v2.1 鏡射多方）
        else if (
          currentBar.close < currentVwap &&
          surgeRatio >= surgeThreshold &&
          stats.first15mLow !== Infinity &&
          currentBar.close <= stats.first15mLow * 1.002
        ) {
          candidatesThisMinute.push({
            symbol,
            action: 'SELL_TO_OPEN',
            price: currentBar.close,
            volumeSurgeRatio: Number(surgeRatio.toFixed(2)),
            vwapDeviationPct,
            timestamp: timeStr,
          });
        }
      }

      // C. 競態處理（§12.1 Step3）：本分鐘所有候選交給 Priority Engine 排序與核准
      // 依 Rank Score 排序 → 依序撮合（§10.4 競爭搶單）
      const rankedCandidates = this.rankCandidates(candidatesThisMinute);
      if (candidatesThisMinute.length > 1) this.conflictsResolved++;
      for (const candidate of rankedCandidates) {
        const briefing = this.briefings.get(candidate.symbol)!;
        const decision = this.rankingEngine.evaluateSignal(candidate, briefing, this.sector);

        if (decision.shouldExecute) {
          const executionPrice = candidate.price * this.slippageMultiplier; // 模擬滑點（1 檔跳動）
          const shares = Math.floor(decision.allocatedCapitalNtd / executionPrice / 1000) * 1000;

          if (shares >= 1000) {
            const isLong = candidate.action === 'BUY_TO_OPEN';
            const newPos: ActivePosition = {
              symbol: candidate.symbol,
              action: candidate.action,
              entryPrice: executionPrice,
              entryTime: candidate.timestamp ?? timeStr,
              shares,
              allocatedCapital: shares * executionPrice,
              stopLossPrice: isLong
                ? executionPrice * (1 - briefing.risk_guardrails.hard_stop_loss_pct / 100)
                : executionPrice * (1 + briefing.risk_guardrails.hard_stop_loss_pct / 100),
              targetPrice1: isLong
                ? executionPrice * (1 + briefing.risk_guardrails.take_profit_target_1_pct / 100)
                : executionPrice * (1 - briefing.risk_guardrails.take_profit_target_1_pct / 100),
              highestPriceSinceEntry: executionPrice,
              lowestPriceSinceEntry: executionPrice,
              rankScore: decision.rankScore,
              forceFlatBy: briefing.trading_plan.active_window.force_flat_by,
            };
            this.activePositions.set(candidate.symbol, newPos);
            this.rankingEngine.registerPosition(candidate.symbol, newPos.allocatedCapital, this.sector);
          }
        } else {
          // engine_effectiveness 統計（§12.5）
          if (/被 Briefing 阻擋/.test(decision.reason)) this.blockedByBriefingBias++;
          else if (/同族群/.test(decision.reason)) this.blockedBySectorLimit++;
          else if (/總曝光上限|不足以買進 1 張|Tier 4|MAX_POSITIONS/.test(decision.reason)) this.blockedByMarginCap++;
        }
      }
    }

    // 時間軸結束：剩餘持倉強制平倉收尾（§12.4 FORCE_FLAT）
    // 即使 forceFlatBy 該分鐘無成交 bar（測試/真實資料缺口），仍以最後已知收盤價結算
    for (const [symbol, pos] of Array.from(this.activePositions.entries())) {
      const bars = marketData.get(symbol);
      const lastBar = bars?.[bars.length - 1];
      if (!lastBar) continue;
      const flatDate = lastBar.datetime.slice(0, 10);
      const flatBar = bars?.find((b) => b.datetime === `${flatDate}T${pos.forceFlatBy}:00+08:00`);
      const exitBar = flatBar ?? lastBar;
      this.closePosition(pos, exitBar, 'FORCE_FLAT', pos.forceFlatBy);
    }

    return this.generateReport();
  }

  /** 合併多日報告（§13.1）：交易紀錄串接、summary 重新統計、test_period 跨日 */
  private mergeDayReports(reports: BacktestReport[], startDate: string, endDate: string): BacktestReport {
    const trades = reports.flatMap((r) => r.trades);
    const totalTrades = trades.length;
    const winTrades = trades.filter((t) => t.pnlNtd > 0);
    const totalPnl = trades.reduce((sum, t) => sum + t.pnlNtd, 0);
    const grossWin = trades.filter((t) => t.pnlNtd > 0).reduce((s, t) => s + t.pnlNtd, 0);
    const grossLoss = Math.abs(trades.filter((t) => t.pnlNtd < 0).reduce((s, t) => s + t.pnlNtd, 0));
    const profitFactor = grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : totalPnl > 0 ? Infinity : 0;

    // max_drawdown：累計損益曲線回撤（跨日連續；負值表示回撤，§12.5 同 generateReport）
    let peak = 0; let maxDrawdown = 0; let cumulative = 0;
    for (const t of trades) {
      cumulative += t.pnlNtd;
      if (cumulative > peak) peak = cumulative;
      const dd = cumulative - peak;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }

    return {
      summary: {
        test_period: startDate === endDate ? startDate : `${startDate} to ${endDate}`,
        total_simulated_days: reports.length,
        total_trades: totalTrades,
        win_rate_pct: totalTrades > 0 ? Number(((winTrades.length / totalTrades) * 100).toFixed(1)) : 0,
        net_total_pnl_ntd: totalPnl,
        profit_factor: profitFactor,
        max_drawdown_ntd: maxDrawdown,
      },
      engine_effectiveness: {
        blocked_by_briefing_bias: reports.reduce((s, r) => s + r.engine_effectiveness.blocked_by_briefing_bias, 0),
        blocked_by_sector_limit: reports.reduce((s, r) => s + r.engine_effectiveness.blocked_by_sector_limit, 0),
        blocked_by_margin_cap: reports.reduce((s, r) => s + r.engine_effectiveness.blocked_by_margin_cap, 0),
        priority_ranking_conflicts_resolved: reports.reduce((s, r) => s + r.engine_effectiveness.priority_ranking_conflicts_resolved, 0),
      },
      trades,
    };
  }

  /** 依 Rank Score 降冪排序（同分鐘多候選，§10.4） */
  private rankCandidates(candidates: SignalCandidate[]): SignalCandidate[] {
    const scored = candidates.map((c) => {
      const briefing = this.briefings.get(c.symbol);
      const preMarketScore = briefing?.bias_assessment.score ?? 0;
      // 與 T020 computeRankScore 同式：0.4×S_pre + 0.5×M_surge − 0.1×D_vwap
      const surgeScore = Math.min(c.volumeSurgeRatio * 20, 100);
      const rankScore = 0.4 * preMarketScore + 0.5 * surgeScore - 0.1 * c.vwapDeviationPct * 15;
      return { c, rankScore };
    });
    scored.sort((a, b) => b.rankScore - a.rankScore);
    return scored.map((s) => s.c);
  }

  private checkExitConditions(pos: ActivePosition, bar: MinuteBar, timeOnly: string): void {
    let shouldExit = false;
    let exitReason: ExitReason = 'FORCE_FLAT';
    let exitPrice = bar.close;
    const isLong = pos.action === 'BUY_TO_OPEN';

    pos.highestPriceSinceEntry = Math.max(pos.highestPriceSinceEntry, bar.high);
    pos.lowestPriceSinceEntry = Math.min(pos.lowestPriceSinceEntry, bar.low);

    if (isLong) {
      if (bar.low <= pos.stopLossPrice) {
        shouldExit = true; exitReason = 'STOP_LOSS'; exitPrice = pos.stopLossPrice;
      } else if (bar.high >= pos.targetPrice1) {
        shouldExit = true; exitReason = 'TAKE_PROFIT'; exitPrice = pos.targetPrice1;
      } else if (timeOnly >= pos.forceFlatBy) {
        shouldExit = true; exitReason = 'FORCE_FLAT'; exitPrice = bar.close;
      }
    } else {
      // 空單：停損在上方（價漲觸發），停利在下方（價跌觸發）——鏡射多方（§7.3）
      if (bar.high >= pos.stopLossPrice) {
        shouldExit = true; exitReason = 'STOP_LOSS'; exitPrice = pos.stopLossPrice;
      } else if (bar.low <= pos.targetPrice1) {
        shouldExit = true; exitReason = 'TAKE_PROFIT'; exitPrice = pos.targetPrice1;
      } else if (timeOnly >= pos.forceFlatBy) {
        // 空單 forceFlatBy 早於多方（§7.4：13:00 而非 13:10）
        shouldExit = true; exitReason = 'FORCE_FLAT'; exitPrice = bar.close;
      }
    }

    if (shouldExit) this.closePosition(pos, bar, exitReason, timeOnly, exitPrice);
  }

  /** 平倉結算：計算稅費淨利潤、寫入 TradeRecord、釋放資金池（§12.4 成本公式） */
  private closePosition(pos: ActivePosition, bar: MinuteBar, exitReason: ExitReason, exitTimeHHMM: string, forcedExitPrice?: number): void {
    const isLong = pos.action === 'BUY_TO_OPEN';
    const exitPrice = forcedExitPrice ?? bar.close;
    // bar.datetime = "2026-08-03T13:09:00+08:00" → 取前 11 字元日期部分 + 指定 HH:MM + 時區後綴（slice(19) 跳過 :ss）
    const exitTime = `${bar.datetime.slice(0, 11)}${exitTimeHHMM}:00${bar.datetime.slice(19)}`;
    const grossIncome = isLong
      ? (exitPrice - pos.entryPrice) * pos.shares
      : (pos.entryPrice - exitPrice) * pos.shares;
    const buyCommission = pos.entryPrice * pos.shares * this.commissionRate;
    const sellCommission = exitPrice * pos.shares * this.commissionRate;
    const tax = exitPrice * pos.shares * this.daytradeTaxRate;
    const netPnl = grossIncome - buyCommission - sellCommission - tax;

    this.tradeCounter++;
    this.completedTrades.push({
      tradeId: `BT-${this.tradeCounter}`,
      symbol: pos.symbol,
      action: pos.action,
      entryTime: pos.entryTime,
      entryPrice: pos.entryPrice,
      exitTime,
      exitPrice,
      shares: pos.shares,
      pnlNtd: Math.round(netPnl),
      exitReason,
      rankScoreAtEntry: pos.rankScore,
    });

    this.activePositions.delete(pos.symbol);
    this.rankingEngine.releasePosition(pos.symbol);
  }

  private extractAndSortTimestamps(marketData: Map<string, MinuteBar[]>): string[] {
    const timeSet = new Set<string>();
    for (const bars of marketData.values()) bars.forEach((b) => timeSet.add(b.datetime));
    return Array.from(timeSet).sort();
  }

  /**
   * 依交易日切分市場資料（§13.1 Grid Search 多日 fixtures）。
   * 每個交易日獨立跑一遍（runningStats/持倉/事件計數器全部重置），最後合併交易紀錄與報告。
   * @returns 依日期排序的 [{ date, marketData }]
   */
  private splitByTradingDay(marketData: Map<string, MinuteBar[]>): { date: string; marketData: Map<string, MinuteBar[]> }[] {
    const dayMap = new Map<string, Map<string, MinuteBar[]>>();
    for (const [symbol, bars] of marketData.entries()) {
      for (const bar of bars) {
        const day = bar.datetime.slice(0, 10); // YYYY-MM-DD
        if (!dayMap.has(day)) dayMap.set(day, new Map());
        const dayData = dayMap.get(day)!;
        if (!dayData.has(symbol)) dayData.set(symbol, []);
        dayData.get(symbol)!.push(bar);
      }
    }
    return Array.from(dayMap.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, d]) => ({ date, marketData: d }));
  }

  private generateReport(): BacktestReport {
    const trades = this.completedTrades;
    const totalTrades = trades.length;
    const winTrades = trades.filter((t) => t.pnlNtd > 0);
    const totalPnl = trades.reduce((sum, t) => sum + t.pnlNtd, 0);

    // max_drawdown（累計淨利潤曲線之最大回撤，§12.5）
    let peak = 0;
    let maxDrawdown = 0;
    let cum = 0;
    for (const t of trades) {
      cum += t.pnlNtd;
      if (cum > peak) peak = cum;
      const dd = cum - peak;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }

    const grossProfit = trades.filter((t) => t.pnlNtd > 0).reduce((sum, t) => sum + t.pnlNtd, 0);
    const grossLoss = Math.abs(trades.filter((t) => t.pnlNtd < 0).reduce((sum, t) => sum + t.pnlNtd, 0));
    const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? grossProfit : 0) : Number((grossProfit / grossLoss).toFixed(2));

    return {
      summary: {
        test_period: this.testPeriodOf(trades),
        total_simulated_days: 1,
        total_trades: totalTrades,
        win_rate_pct: totalTrades > 0 ? Number(((winTrades.length / totalTrades) * 100).toFixed(1)) : 0,
        net_total_pnl_ntd: totalPnl,
        profit_factor: profitFactor,
        max_drawdown_ntd: maxDrawdown,
      },
      engine_effectiveness: {
        blocked_by_briefing_bias: this.blockedByBriefingBias,
        blocked_by_sector_limit: this.blockedBySectorLimit,
        blocked_by_margin_cap: this.blockedByMarginCap,
        priority_ranking_conflicts_resolved: this.conflictsResolved,
      },
      trades,
    };
  }

  private testPeriodOf(trades: TradeRecord[]): string {
    if (trades.length === 0) return '';
    const first = trades[0].entryTime.slice(0, 10);
    const last = trades[trades.length - 1].exitTime.slice(0, 10);
    return `${first} to ${last}`;
  }
}
