// 參數網格搜尋（T023，§13.1 Grid Search）
// - 前置準備（§13.1）：Briefing.key_levels.volume_surge_threshold 已參數化（T019）；Simulator 觸發條件讀取（T022）
// - 搜尋空間：停損 [1.0, 1.2, 1.5, 1.8, 2.0, 2.2, 2.5] × 爆量 [2.0, 2.5, 3.0, 3.5, 4.0, 5.0] = 42 組合
// - 每迭代全新 DayBrainBacktestSimulator 清空狀態（§13.1）；數據只載入一次（CsvDataLoader.loadDirectory）
// - 注入測試參數至 Briefing：hard_stop_loss_pct / volume_surge_threshold，其餘欄位 mock 填值（§13.1 範例）
// - 結果過濾：交易次數 < 5 之無效組合濾除；依淨利潤降冪輸出 Top 5（SL/Surge/PnL/勝率/PF/交易次數）
// - 進度輸出：\r進度: N/42 組合已完成
// - 獲利高原判讀（§13.2）：以最高淨利潤之 85% 為高原門檻，找出「同爆量倍數 × 停損連續區間」為高原區間；
//   高原外高排名組合（交易次數銳減）標註孤島最佳解警示
// - CLI：npm run grid-search（非交易日執行，§18.1）
// - 為 T024 WFO 之 IS 窗口最佳化基礎（§13.3）

import * as path from 'node:path';
import { CsvDataLoader } from './data_loader.js';
import { DayBrainBacktestSimulator, type BacktestReport } from './simulator.js';
import type { TacticalBriefing } from '../briefing/generator.js';
import type { MinuteBar } from './types.js';

/** 搜尋空間（§13.1） */
export const STOP_LOSS_OPTIONS = [1.0, 1.2, 1.5, 1.8, 2.0, 2.2, 2.5];
export const SURGE_OPTIONS = [2.0, 2.5, 3.0, 3.5, 4.0, 5.0];

export interface GridSearchParams {
  stopLossPct: number;
  surgeMultiplier: number;
}

export interface GridSearchResult extends GridSearchParams {
  totalTrades: number;
  winRatePct: number;
  netTotalPnlNtd: number;
  profitFactor: number;
  /** §13.2：是否位於獲利高原區間 */
  onPlateau: boolean;
  /** §13.2：孤島最佳解警示 */
  islandWarning?: string;
}

export interface GridSearchReport {
  /** 搜尋空間 */
  stopLossOptions: number[];
  surgeOptions: number[];
  /** 依淨利潤降冪之有效組合（交易次數 ≥ minTrades） */
  results: GridSearchResult[];
  /** 高原區間描述（§13.2） */
  plateau: string | null;
  /** 孤島最佳解清單（§13.2） */
  islands: GridSearchResult[];
  /** 實戰建議（高原中心點） */
  recommendation: { stopLossPct: number; surgeMultiplier: number } | null;
  /** 執行統計 */
  meta: { totalCombinations: number; validCombinations: number; dataSymbols: number; dataBars: number };
}

export interface GridSearchOptions {
  stopLossOptions?: number[];
  surgeOptions?: number[];
  /** 無效組合過濾門檻（§13.1：< 5 濾除） */
  minTrades?: number;
  /** 高原判讀門檻比例（§13.2：最高淨利潤之比例，預設 0.85） */
  plateauRatio?: number;
  /** 每個標的之 mock briefing（若未提供則依 symbols 自動產生） */
  briefings?: TacticalBriefing[];
  /** 每標的 briefing 基準（bias/score/其他風險參數） */
  briefingTemplate?: Omit<TacticalBriefing, 'target'>;
  /** 進度輸出（預設 console.log 回車覆寫） */
  onProgress?: (completed: number, total: number) => void;
  /** 每迭代 Simulator 建構選項（資金池等） */
  simulatorOptions?: ConstructorParameters<typeof DayBrainBacktestSimulator>[0];
}

/** 依 symbol 產生 mock briefing（§13.1 範例結構），參數由呼叫端注入 */
export function makeGridBriefing(
  symbol: string,
  params: GridSearchParams,
  template: Omit<TacticalBriefing, 'target'>,
): TacticalBriefing {
  return {
    ...template,
    target: { symbol, name: symbol, market: 'TWSE', yesterday_close: 100 },
    trading_plan: {
      ...template.trading_plan,
      key_levels: {
        ...template.trading_plan.key_levels,
        volume_surge_threshold: params.surgeMultiplier, // §13.1：注入測試的爆量倍數
      },
    },
    risk_guardrails: {
      ...template.risk_guardrails,
      hard_stop_loss_pct: params.stopLossPct, // §13.1：注入測試的停損趴數
    },
  };
}

/** §13.1 預設 briefing 模板（LONG_ONLY 多方日） */
export function defaultBriefingTemplate(): Omit<TacticalBriefing, 'target'> {
  return {
    _lineage: { generated_at: new Date().toISOString(), agent_version: 'v2.0', mcp_server_version: 'v1.3', data_sources: [] },
    bias_assessment: { bias: 'LONG_ONLY', score: 85, confidence: 'HIGH', scoring_breakdown: [] },
    trading_plan: {
      allowed_actions: ['BUY_TO_OPEN'],
      blocked_actions: ['SELL_TO_OPEN'],
      active_window: { start_time: '09:05', no_new_entry_after: '11:30', force_flat_by: '13:10' },
      key_levels: { anchor_vwap_estimate: 100, breakout_pivot_price: 100, support_invalidation_price: 100, volume_surge_threshold: 2.5 },
    },
    risk_guardrails: {
      max_position_size_shares: 2000,
      hard_stop_loss_pct: 1.5,
      take_profit_target_1_pct: 2.0,
      trailing_stop_activation_pct: 2.0,
      trailing_stop_callback_pct: 1.0,
      max_drawdown_limit_ntd: 30000,
      safety_flags: { is_disposition: false, can_daytrade: true, can_short_first: true, earnings_announcement_today: false },
    },
  };
}

/**
 * 獲利高原判讀（§13.2）：
 * 1. 以有效組合最高淨利潤之 plateauRatio 為高原門檻
 * 2. 找出「同一爆量倍數下、停損連續 ≥2 個都過門檻」的區間 → 高原
 * 3. 高原區間外、但淨利潤仍高（≥ 門檻）且交易次數銳減（≤ 高原平均交易次數之 50%）→ 孤島最佳解警示
 */
export function identifyPlateau(
  results: GridSearchResult[],
  plateauRatio: number,
): { plateau: string | null; islands: GridSearchResult[] } {
  const valid = results.filter((r) => r.netTotalPnlNtd > 0);
  if (valid.length === 0) return { plateau: null, islands: [] };

  const maxPnl = Math.max(...valid.map((r) => r.netTotalPnlNtd));
  const threshold = maxPnl * plateauRatio;
  const onPlateau = valid.filter((r) => r.netTotalPnlNtd >= threshold);
  const avgTrades = onPlateau.reduce((s, r) => s + r.totalTrades, 0) / onPlateau.length;

  // 高原區間：同一 surge 下停損連續 ≥2 個過門檻
  // 停損檔距 0.2~0.3（[1.0,1.2,1.5,1.8,2.0,2.2,2.5]），相鄰差 ≤0.31 即視為連續
  const plateauRanges: string[] = [];
  for (const surge of SURGE_OPTIONS) {
    const candidates = onPlateau.filter((r) => Math.abs(r.surgeMultiplier - surge) < 1e-9).sort((a, b) => a.stopLossPct - b.stopLossPct);
    // 找連續區間
    let runStart: number | null = null;
    let prev: number | null = null;
    for (const c of candidates) {
      if (runStart === null) { runStart = c.stopLossPct; prev = c.stopLossPct; continue; }
      if (c.stopLossPct - prev! > 0.31) { // 超過最大檔距 → 不連續
        if (prev! - runStart >= 0.11) plateauRanges.push(`Surge ${surge}×, SL ${runStart.toFixed(1)}–${prev!.toFixed(1)}%`);
        runStart = c.stopLossPct;
      }
      prev = c.stopLossPct;
    }
    if (runStart !== null && prev !== null && prev - runStart >= 0.11) plateauRanges.push(`Surge ${surge}×, SL ${runStart.toFixed(1)}–${prev.toFixed(1)}%`);
  }

  // 孤島：過門檻但不在任何高原區間、且交易次數銳減
  const islands = onPlateau.filter((r) => {
    const inRange = plateauRanges.some((range) => {
      const m = range.match(/Surge ([0-9.]+)×, SL ([0-9.]+)–([0-9.]+)%/);
      if (!m) return false;
      return Math.abs(r.surgeMultiplier - parseFloat(m[1])) < 1e-9 && r.stopLossPct >= parseFloat(m[2]) - 0.01 && r.stopLossPct <= parseFloat(m[3]) + 0.01;
    });
    return !inRange && r.totalTrades <= avgTrades * 0.5;
  });

  const plateau = plateauRanges.length > 0 ? plateauRanges.join('；') : null;
  return { plateau, islands };
}

export class GridSearchRunner {
  private options: Required<Pick<GridSearchOptions, 'minTrades' | 'plateauRatio'>> &
    Pick<GridSearchOptions, 'briefings' | 'briefingTemplate' | 'simulatorOptions' | 'onProgress'>;

  constructor(options: GridSearchOptions = {}) {
    this.options = {
      minTrades: options.minTrades ?? 5,
      plateauRatio: options.plateauRatio ?? 0.85,
      briefings: options.briefings,
      briefingTemplate: options.briefingTemplate,
      simulatorOptions: options.simulatorOptions,
      onProgress: options.onProgress,
    };
  }

  /**
   * 執行完整網格搜尋（§13.1）。
   * @param marketDataMap 已載入之歷史資料（只載入一次）
   */
  public run(marketDataMap: Map<string, MinuteBar[]>): GridSearchReport {
    const stopLossOptions = this.options.briefingTemplate ? undefined : STOP_LOSS_OPTIONS;
    const surgeOptions = this.options.briefingTemplate ? undefined : SURGE_OPTIONS;
    void stopLossOptions; void surgeOptions;

    const results: GridSearchResult[] = [];
    const totalCombinations = STOP_LOSS_OPTIONS.length * SURGE_OPTIONS.length;
    let completed = 0;

    const symbols = Array.from(marketDataMap.keys());
    const totalBars = Array.from(marketDataMap.values()).reduce((s, b) => s + b.length, 0);

    for (const sl of STOP_LOSS_OPTIONS) {
      for (const surge of SURGE_OPTIONS) {
        // §13.1：每迭代全新 Simulator 清空狀態
        const simulator = new DayBrainBacktestSimulator(this.options.simulatorOptions);

        // 注入測試參數至 Briefing（§13.1）
        const template = this.options.briefingTemplate ?? defaultBriefingTemplate();
        const briefings = this.options.briefings ??
          symbols.map((symbol) => makeGridBriefing(symbol, { stopLossPct: sl, surgeMultiplier: surge }, template));

        simulator.loadBriefings(briefings);
        const report: BacktestReport = simulator.runSimulation(marketDataMap);

        results.push({
          stopLossPct: sl,
          surgeMultiplier: surge,
          totalTrades: report.summary.total_trades,
          winRatePct: report.summary.win_rate_pct,
          netTotalPnlNtd: report.summary.net_total_pnl_ntd,
          profitFactor: report.summary.profit_factor,
          onPlateau: false,
        });

        completed++;
        if (this.options.onProgress) this.options.onProgress(completed, totalCombinations);
        else process.stdout.write(`\r進度: ${completed}/${totalCombinations} 組合已完成...`);
      }
    }

    // 結果過濾與排序（§13.1）：濾除 < minTrades、依淨利潤降冪
    const validResults = results
      .filter((r) => r.totalTrades >= this.options.minTrades)
      .sort((a, b) => b.netTotalPnlNtd - a.netTotalPnlNtd);

    // 獲利高原判讀（§13.2）
    const { plateau, islands } = identifyPlateau(validResults, this.options.plateauRatio);
    const plateauSet = new Set(islands.map((r) => `${r.stopLossPct}|${r.surgeMultiplier}`));
    validResults.forEach((r) => {
      if (r.netTotalPnlNtd > 0 && r.netTotalPnlNtd >= Math.max(...validResults.map((v) => v.netTotalPnlNtd)) * this.options.plateauRatio) {
        r.onPlateau = true;
      }
      const island = islands.find((i) => Math.abs(i.stopLossPct - r.stopLossPct) < 1e-9 && Math.abs(i.surgeMultiplier - r.surgeMultiplier) < 1e-9);
      if (island) r.islandWarning = '交易次數銳減，可能為過度擬合（§13.2 孤島）';
      if (plateauSet.has(`${r.stopLossPct}|${r.surgeMultiplier}`)) r.islandWarning = '交易次數銳減，可能為過度擬合（§13.2 孤島）';
    });

    // 實戰建議：高原中心點（§13.2：選高原內淨利潤最高者）
    const plateauMembers = validResults.filter((r) => r.onPlateau);
    const recommendation = plateauMembers.length > 0
      ? { stopLossPct: plateauMembers[0].stopLossPct, surgeMultiplier: plateauMembers[0].surgeMultiplier }
      : validResults.length > 0
        ? { stopLossPct: validResults[0].stopLossPct, surgeMultiplier: validResults[0].surgeMultiplier }
        : null;

    return {
      stopLossOptions: STOP_LOSS_OPTIONS,
      surgeOptions: SURGE_OPTIONS,
      results: validResults,
      plateau,
      islands,
      recommendation,
      meta: {
        totalCombinations,
        validCombinations: validResults.length,
        dataSymbols: symbols.length,
        dataBars: totalBars,
      },
    };
  }
}

/** CLI 入口：載入 testdata/historical_1m 並執行搜尋（npm run grid-search） */
export async function runGridSearchCli(dataDir?: string): Promise<GridSearchReport> {
  const dir = dataDir ?? path.join(process.cwd(), 'testdata', 'historical_1m');
  const loader = new CsvDataLoader({ volumeUnit: 'LOTS' });
  const marketDataMap = await loader.loadDirectory(dir);

  console.log('🚀 啟動 DayBrain 參數網格搜尋 (Grid Search)...');
  console.log(`資料: ${marketDataMap.size} 檔標的（${Array.from(marketDataMap.values()).reduce((s, b) => s + b.length, 0)} 筆 1 分 K）`);
  console.log(`搜尋空間: 停損 ${STOP_LOSS_OPTIONS.join('/')}% × 爆量 ${SURGE_OPTIONS.join('/')}x`);

  const runner = new GridSearchRunner();
  const report = runner.run(marketDataMap);
  process.stdout.write('\n');

  console.log('\n📊 網格搜尋完成！最佳參數組合 Top 5 (依淨利潤排序):');
  console.table(report.results.slice(0, 5).map((r, index) => ({
    '排名': `#${index + 1}`,
    '停損 % (SL)': `${r.stopLossPct.toFixed(1)}%`,
    '爆量倍數 (Surge)': `${r.surgeMultiplier.toFixed(1)}x`,
    '總利潤 (NTD)': r.netTotalPnlNtd.toLocaleString(),
    '勝率 (%)': `${r.winRatePct}%`,
    '獲利因子 (PF)': r.profitFactor,
    '交易次數': r.totalTrades,
  })));

  if (report.plateau) {
    console.log(`\n🟢 獲利高原區間（§13.2）: ${report.plateau}`);
  } else {
    console.log('\n⚠️ 未偵測到穩定獲利高原（樣本可能不足）');
  }
  if (report.islands.length > 0) {
    console.log('🔴 孤島最佳解警示（§13.2 過度擬合風險）:');
    report.islands.forEach((r) => {
      console.log(`  - SL ${r.stopLossPct}% × Surge ${r.surgeMultiplier}x: 交易僅 ${r.totalTrades} 次（高原平均顯著更高）`);
    });
  }
  if (report.recommendation) {
    console.log(`\n✅ 實戰建議（高原中心點）: SL ${report.recommendation.stopLossPct}%, Surge ${report.recommendation.surgeMultiplier}x`);
  }
  console.log(`\n執行統計: ${report.meta.totalCombinations} 組合 / ${report.meta.validCombinations} 有效（≥5 交易）/ 標的 ${report.meta.dataSymbols} / K 線 ${report.meta.dataBars} 筆`);
  return report;
}
