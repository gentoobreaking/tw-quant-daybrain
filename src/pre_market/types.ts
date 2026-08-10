// 盤前流程型別（T006，§4 Phase 0/1）
// 候選清單僅產生「規則計算」之觸發價/停損價與依據；
// Bias 鎖定（§5）與 Tactical Briefing（§9）由 T016/T019 承接。

/** mcp 呼叫函式（依賴注入；測試以 stub 替換） */
export type McpCallFn = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; _lineage: Record<string, unknown>; _chart_meta?: Record<string, unknown> }>;

/** Freshness Gate 檢查函式（依賴注入） */
export type GateCheckFn = (
  envelope: { _lineage: Record<string, unknown> },
  scope: 'PRE_MARKET' | 'INTRADAY_SIGNAL' | 'INTRADAY_MARKET' | 'HISTORICAL',
  options?: { symbol?: string },
) => { passed: boolean; cause?: string; state: string };

/** 選股路徑來源 */
export type SelectionSource = 'INSTITUTIONAL' | 'ABNORMAL' | 'ANNOUNCEMENT';

/** 盤前候選標的（T006 產出） */
export interface PreMarketCandidate {
  symbol: string;
  name?: string;
  /** 方向（T016 Bias 鎖定前之初步預判；最終以 Briefing 為準） */
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  /** 做多觸發價：昨日高點（突破樞紐）；盤中需站穩 VWAP 才生效 */
  triggerPrice: number;
  /** 硬停損：-1.5%（以昨日收盤為錨）或跌破今日 VWAP（先觸發者） */
  stopLossPrice: number;
  /** 昨日收盤（錨定價） */
  yesterdayClose: number;
  /** 昨日高點 */
  yesterdayHigh: number;
  /** catalyst 敘事（規則彙整；LLM 潤飾由 T016 §16 負責） */
  catalyst: string;
  /** 風控狀態（scan_daytrade_eligibility.risk_status） */
  riskStatus?: string;
  /** 覆蓋此標的之選股路徑（去重後記錄來源） */
  sources: SelectionSource[];
  /** 籌碼分（投信+外資淨買超；用於排序，非 Bias 評分） */
  flowScore: number;
}

/** 單一標的之風控掃描結果 */
export interface EligibilityResult {
  symbol: string;
  eligible: boolean;
  riskStatus?: string;
  isAttention?: boolean;
  isDisposition?: boolean;
  marginRestricted?: boolean;
}

/** Phase 0 資料缺口 */
export interface DataGap {
  tool: string;
  reason: string;
}

/** 盤前報告（結構化輸出） */
export interface PreMarketReport {
  date: string;
  /** Phase 0 連線就緒 */
  connectionReady: boolean;
  /** Phase 0 資料缺口清單（§3.2 降級註明） */
  dataGaps: DataGap[];
  /** Phase 1 候選清單（3–5 檔） */
  candidates: PreMarketCandidate[];
  /** 設定之 mcp Watchlist（≤15 檔） */
  watchlist: string[];
  /** 是否低訊號日（選股不足 3 檔，已降門檻/註明） */
  lowSignalDay: boolean;
  /** 盤前報告產出時間 */
  generatedAt: string;
}
