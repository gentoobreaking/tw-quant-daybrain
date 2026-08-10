// Walk-Forward Optimization（T024，§13.3/§13.4）
// - 滾動視窗（§13.3）：IS 3 個月 + OOS 1 個月，窗口向前推進 OOS 月數
// - IS 最佳化（§13.3-A）：於 IS 資料執行 Grid Search（T023 邏輯），選 Profit Factor 最高且交易 ≥3 之參數
// - OOS 無偏檢驗（§13.3-B）：凍結 IS 最佳參數，於完全未看過之 OOS 月份回測
// - 窗口輸出（§13.3 WfoWindowResult）：windowId / IS 範圍 / OOS 範圍 / bestInSampleParams / oosPnlNtd / oosWinRatePct / oosTradesCount
// - 拼接 OOS 績效：累計所有 OOS 月份損益為權益曲線（totalOosPnlNtd）
// - WFE（§13.3 calculateWfoEfficiency + §13.4）：OOS 獲利窗口比率；>60% 過關、<30% 極度過度擬合不可上線
// - 參數漂移穩定度（§13.4）：輸出每窗口 bestInSampleParams 變化序列，標註健康（穩定）vs 危險（劇烈跳動）
// - CLI：npm run wfo（非交易日執行，§18.1）

import { DayBrainBacktestSimulator } from './simulator.js';
import { makeGridBriefing, defaultBriefingTemplate } from './grid_search.js';
import type { TacticalBriefing } from '../briefing/generator.js';
import type { MinuteBar } from './types.js';

export interface WfoWindowResult {
  windowId: number;
  inSampleRange: { start: string; end: string };
  outOfSampleRange: { start: string; end: string };
  bestInSampleParams: { stopLossPct: number; surgeMultiplier: number; isProfitFactor: number };
  oosPnlNtd: number;
  oosWinRatePct: number;
  oosTradesCount: number;
}

export interface WfoReport {
  windowResults: WfoWindowResult[];
  totalOosPnlNtd: number;
  wfoEfficiencyRatio: number;
  /** §13.4：WFE 判讀（PASS / OVERFIT / INCONCLUSIVE） */
  wfeVerdict: 'PASS' | 'OVERFIT' | 'INCONCLUSIVE';
  /** §13.4：參數漂移穩定度 */
  parameterStability: {
    status: 'HEALTHY' | 'DANGEROUS';
    detail: string;
    stopLossSequence: number[];
    surgeSequence: number[];
  };
}

export class WalkForwardOptimizer {
  private inSampleMonths: number;
  private outOfSampleMonths: number;
  private stopLossOptions = [1.0, 1.5, 1.8, 2.0, 2.5];
  private surgeOptions = [2.0, 2.5, 3.0, 3.5, 4.0];

  constructor(inSampleMonths: number = 3, outOfSampleMonths: number = 1) {
    this.inSampleMonths = inSampleMonths;
    this.outOfSampleMonths = outOfSampleMonths;
  }

  public async runWfo(marketDataMap: Map<string, MinuteBar[]>): Promise<WfoReport> {
    const availableMonths = this.extractSortedMonths(marketDataMap);
    const windowResults: WfoWindowResult[] = [];

    let currentStartIdx = 0;
    let windowId = 1;

    while (currentStartIdx + this.inSampleMonths + this.outOfSampleMonths <= availableMonths.length) {
      const isMonths = availableMonths.slice(currentStartIdx, currentStartIdx + this.inSampleMonths);
      const oosMonths = availableMonths.slice(
        currentStartIdx + this.inSampleMonths,
        currentStartIdx + this.inSampleMonths + this.outOfSampleMonths,
      );

      // 切分資料集
      const isData = this.filterDataByMonths(marketDataMap, isMonths);
      const oosData = this.filterDataByMonths(marketDataMap, oosMonths);

      // A. 在 In-Sample 上執行 Grid Search 尋找最佳參數（§13.3-A）
      const bestIsParam = this.findBestParamsOnGrid(isData);

      // B. 拿最佳參數，在 Out-of-Sample（未來數據）上無偏檢驗（§13.3-B）
      const oosReport = this.runSingleBacktest(oosData, bestIsParam.stopLossPct, bestIsParam.surgeMultiplier);

      windowResults.push({
        windowId,
        inSampleRange: { start: isMonths[0], end: isMonths[isMonths.length - 1] },
        outOfSampleRange: { start: oosMonths[0], end: oosMonths[oosMonths.length - 1] },
        bestInSampleParams: bestIsParam,
        oosPnlNtd: oosReport.netTotalPnlNtd,
        oosWinRatePct: oosReport.winRatePct,
        oosTradesCount: oosReport.totalTrades,
      });

      currentStartIdx += this.outOfSampleMonths; // 窗口向前推進 OOS 月數
      windowId++;
    }

    const totalOosPnlNtd = windowResults.reduce((sum, w) => sum + w.oosPnlNtd, 0);
    const wfoEfficiencyRatio = this.calculateWfoEfficiency(windowResults);

    return {
      windowResults,
      totalOosPnlNtd,
      wfoEfficiencyRatio,
      wfeVerdict: this.wfeVerdictOf(wfoEfficiencyRatio),
      parameterStability: this.assessParameterStability(windowResults),
    };
  }

  /** §13.3-A：IS 資料上跑 Grid Search，選 Profit Factor 最高且交易 ≥3 之參數 */
  private findBestParamsOnGrid(dataMap: Map<string, MinuteBar[]>): WfoWindowResult['bestInSampleParams'] {
    let bestParam = { stopLossPct: 1.5, surgeMultiplier: 2.5, isProfitFactor: 0 };

    for (const sl of this.stopLossOptions) {
      for (const surge of this.surgeOptions) {
        const report = this.runSingleBacktest(dataMap, sl, surge);
        // 交易次數 >= 3 筆且 Profit Factor 最高（§13.3-A）
        if (report.totalTrades >= 3 && report.profitFactor > bestParam.isProfitFactor) {
          bestParam = { stopLossPct: sl, surgeMultiplier: surge, isProfitFactor: report.profitFactor };
        }
      }
    }
    return bestParam;
  }

  /** 單一參數組合回測（模擬 §13.1 範例：mock briefings + 全新 Simulator） */
  private runSingleBacktest(
    dataMap: Map<string, MinuteBar[]>,
    sl: number,
    surge: number,
  ): { netTotalPnlNtd: number; winRatePct: number; totalTrades: number; profitFactor: number } {
    const simulator = new DayBrainBacktestSimulator({ totalMarginPoolNtd: 3_000_000 });
    const template = defaultBriefingTemplate();
    const mockBriefings: TacticalBriefing[] = Array.from(dataMap.keys()).map((symbol) =>
      makeGridBriefing(symbol, { stopLossPct: sl, surgeMultiplier: surge }, template),
    );
    simulator.loadBriefings(mockBriefings);
    const summary = simulator.runSimulation(dataMap).summary;
    return {
      netTotalPnlNtd: summary.net_total_pnl_ntd,
      winRatePct: summary.win_rate_pct,
      totalTrades: summary.total_trades,
      profitFactor: summary.profit_factor,
    };
  }

  private extractSortedMonths(marketDataMap: Map<string, MinuteBar[]>): string[] {
    const monthSet = new Set<string>();
    for (const bars of marketDataMap.values()) bars.forEach((b) => monthSet.add(b.datetime.substring(0, 7)));
    return Array.from(monthSet).sort();
  }

  private filterDataByMonths(marketDataMap: Map<string, MinuteBar[]>, months: string[]): Map<string, MinuteBar[]> {
    const filteredMap = new Map<string, MinuteBar[]>();
    const monthSet = new Set(months);
    for (const [symbol, bars] of marketDataMap.entries()) {
      const filteredBars = bars.filter((b) => monthSet.has(b.datetime.substring(0, 7)));
      if (filteredBars.length > 0) filteredMap.set(symbol, filteredBars);
    }
    return filteredMap;
  }

  /** §13.3：OOS 獲利窗口比率（WFE = 獲利窗口數 / 總窗口數 × 100） */
  private calculateWfoEfficiency(results: WfoWindowResult[]): number {
    const positiveWindows = results.filter((r) => r.oosPnlNtd > 0).length;
    return Number(((positiveWindows / (results.length || 1)) * 100).toFixed(1));
  }

  /** §13.4：WFE 判讀。>60% 過關；<30% 極度過度擬合不可上線；中間為樣本不足/持平 */
  private wfeVerdictOf(wfe: number): 'PASS' | 'OVERFIT' | 'INCONCLUSIVE' {
    if (wfe > 60) return 'PASS';
    if (wfe < 30) return 'OVERFIT';
    return 'INCONCLUSIVE';
  }

  /**
   * §13.4 參數漂移穩定度：觀察各窗口 bestInSampleParams 變化序列。
   * - 健康：所有窗口參數落於小鄰域（stopLoss 極差 ≤ 0.4、surge 極差 ≤ 0.5）
   * - 危險：參數劇烈跳動（超出上述範圍）——策略對市場極度敏感、缺乏穩健性
   */
  private assessParameterStability(results: WfoWindowResult[]): WfoReport['parameterStability'] {
    const stopLossSequence = results.map((r) => r.bestInSampleParams.stopLossPct);
    const surgeSequence = results.map((r) => r.bestInSampleParams.surgeMultiplier);

    if (results.length === 0) {
      return {
        status: 'DANGEROUS',
        detail: '無任何窗口（樣本月份不足）',
        stopLossSequence,
        surgeSequence,
      };
    }

    const slRange = Math.max(...stopLossSequence) - Math.min(...stopLossSequence);
    const surgeRange = Math.max(...surgeSequence) - Math.min(...surgeSequence);
    const healthy = slRange <= 0.4 && surgeRange <= 0.5;

    return {
      status: healthy ? 'HEALTHY' : 'DANGEROUS',
      detail: `stopLoss 極差 ${slRange.toFixed(1)}（${stopLossSequence.join(' → ')}）、surge 極差 ${surgeRange.toFixed(1)}（${surgeSequence.join(' → ')}）`,
      stopLossSequence,
      surgeSequence,
    };
  }
}

/** CLI 入口：載入 testdata/historical_1m 並執行 WFO（npm run wfo，§18.1 非交易日執行） */
export async function runWfoCli(dataDir?: string): Promise<WfoReport> {
  const { CsvDataLoader } = await import('./data_loader.js');
  const path = await import('node:path');
  const dir = dataDir ?? path.join(process.cwd(), 'testdata', 'historical_1m');
  const loader = new CsvDataLoader({ volumeUnit: 'LOTS' });
  const marketDataMap = await loader.loadDirectory(dir);

  console.log('🚀 啟動 Walk-Forward Optimization (WFO)...');
  const months = new Set<string>();
  for (const bars of marketDataMap.values()) bars.forEach((b) => months.add(b.datetime.substring(0, 7)));
  console.log(`資料: ${marketDataMap.size} 檔標的 / ${months.size} 個月（${Array.from(months).sort().join(', ')}）`);
  console.log(`滾動視窗: IS ${3} 個月 + OOS ${1} 個月（需要至少 4 個月資料）`);

  if (months.size < 4) {
    console.warn('⚠️ 樣本月份不足 4 個月，無法形成任何 WFO 窗口（fixtures 僅 1 個月）。請提供多月份歷史資料。');
  }

  const optimizer = new WalkForwardOptimizer(3, 1);
  const report = await optimizer.runWfo(marketDataMap);

  console.log('\n📊 WFO 窗口結果:');
  console.table(report.windowResults.map((w) => ({
    '窗口': `W${w.windowId}`,
    'IS 範圍': `${w.inSampleRange.start} ~ ${w.inSampleRange.end}`,
    'OOS 範圍': `${w.outOfSampleRange.start} ~ ${w.outOfSampleRange.end}`,
    'IS 最佳 SL/Surge': `${w.bestInSampleParams.stopLossPct}% / ${w.bestInSampleParams.surgeMultiplier}x`,
    'OOS PnL': w.oosPnlNtd.toLocaleString(),
    'OOS 勝率': `${w.oosWinRatePct}%`,
    'OOS 交易': w.oosTradesCount,
  })));

  console.log(`\n累計 OOS 淨利（權益曲線終點）: ${report.totalOosPnlNtd.toLocaleString()} NTD`);
  console.log(`WFE（OOS 獲利窗口比率）: ${report.wfoEfficiencyRatio}%`);
  console.log(`WFE 判讀（§13.4）: ${report.wfeVerdict === 'PASS' ? '✅ 過關（>60%）' : report.wfeVerdict === 'OVERFIT' ? '🔴 極度過度擬合（<30%），絕不能上線' : '🟡 持平（30–60%），需更多樣本'}`);
  console.log(`參數漂移穩定度（§13.4）: ${report.parameterStability.status === 'HEALTHY' ? '🟢 健康（參數穩定）' : '🔴 危險（參數劇烈跳動）'} — ${report.parameterStability.detail}`);

  return report;
}
