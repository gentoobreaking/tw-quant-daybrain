// §2.2 工具契約型別定義
// 與 tw-quant-mcp v1.3 規格對齊：18 個工具之輸入/輸出型別。

// ===== 盤前/基礎 =====

/** set_active_watchlist：設定觀察清單（1~15 檔，mcp 端硬限制） */
export interface SetActiveWatchlistArgs {
  symbols: string[]; // 1~15 檔
}

// ===== 盤中監控 =====

/** get_intraday_vwap：當日累計 VWAP、高低點、Fib 支撐壓力 */
export interface VwapResult {
  symbol: string;
  vwap: number;
  high: number;
  low: number;
  current_price?: number;
  fib_levels?: Record<string, number>;
  [key: string]: unknown;
}

/** detect_volume_surge：爆量/急拉訊號 */
export interface VolumeSurgeResult {
  symbol: string;
  volumeSurgeRatio?: number;
  volumeSurgeType?: string; // 'BULLISH_SURGE' | 'BEARISH_BREAKDOWN' | ...
  is_surge?: boolean;
  [key: string]: unknown;
}

/** get_intraday_quote：即時報價 + 五檔 */
export interface IntradayQuoteResult {
  symbol: string;
  price: number;
  bids: Array<{ price: number; volume: number }>;
  asks: Array<{ price: number; volume: number }>;
  [key: string]: unknown;
}

/** get_intraday_kline：1m/5m Candle 序列 */
export interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface IntradayKlineResult {
  symbol: string;
  timeframe: '1m' | '5m';
  candles: Candle[];
  [key: string]: unknown;
}

// ===== 市場濾網 =====

/** get_market_summary：全市場漲跌家數/成交量/漲跌停 */
export interface MarketSummaryResult {
  date: string;
  advance: number;
  decline: number;
  unchanged?: number;
  total_volume?: number;
  limit_up?: number;
  limit_down?: number;
  [key: string]: unknown;
}

/** get_futures_daily_ohlc：台指期 OHLC */
export interface FuturesOhlcResult {
  contract: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  [key: string]: unknown;
}

/** get_put_call_ratio：買賣權比 */
export interface PutCallRatioResult {
  date: string;
  pcr_volume?: number;
  pcr_oi?: number;
  [key: string]: unknown;
}

// ===== 盤前選股 =====

/** get_institutional_investors：三大法人買賣超 */
export interface InstitutionalInvestorsResult {
  date: string;
  foreign_net?: number;
  investment_trust_net?: number;
  dealer_net?: number;
  [key: string]: unknown;
}

/** get_major_announcements：重大訊息 */
export interface MajorAnnouncement {
  symbol?: string;
  title: string;
  date?: string;
  [key: string]: unknown;
}
export interface MajorAnnouncementsResult {
  announcements: MajorAnnouncement[];
  [key: string]: unknown;
}

/** get_abnormal_trading：異常成交量（注意股） */
export interface AbnormalTradingResult {
  date: string;
  stocks: Array<{ symbol: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** get_stock_daily_kline：盤後日 K */
export interface StockDailyKlineResult {
  symbol: string;
  period: 'day' | 'week' | 'month';
  candles: Candle[];
  [key: string]: unknown;
}

// ===== 風險掃描 =====

/** scan_daytrade_eligibility：當沖資格/處置/注意/停資停券 */
export interface DaytradeEligibilityResult {
  symbol: string;
  eligible: boolean;
  risk_status?: string;
  is_attention?: boolean;
  is_disposition?: boolean;
  margin_restricted?: boolean;
  [key: string]: unknown;
}

// ===== 行事曆 =====

/** get_trading_calendar：交易日 */
export interface TradingCalendarResult {
  year: number;
  trading_days: string[];
  holidays: Array<{ date: string; name?: string }>;
  [key: string]: unknown;
}

/** get_symbol_list：上市/上櫃代碼表 */
export interface SymbolListResult {
  symbols: Array<{ symbol: string; name?: string; market?: string }>;
  [key: string]: unknown;
}

// ===== v2.0 新增（§5 Bias 決策樹輸入）=====

/** get_pre_market_quote：08:40-08:55 試撮價與量能 */
export interface PreMarketQuoteResult {
  symbol: string;
  pre_market_price?: number;
  pre_market_volume?: number;
  [key: string]: unknown;
}

/** get_taifex_night：台指夜盤 */
export interface TaifexNightResult {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  change_pct?: number;
  [key: string]: unknown;
}

/** get_us_market：NVDA/TSM ADR 等美股 */
export interface UsMarketResult {
  date: string;
  nvda?: { price: number; change_pct: number };
  tsm?: { price: number; change_pct: number };
  [key: string]: unknown;
}

/** 工具契約查詢表（工具名 → args/output 型別，供型別安全呼叫） */
export interface ToolContract {
  name: string;
  args: unknown;
  output: unknown;
}

export const TOOL_CONTRACTS = [
  'set_active_watchlist',
  'get_intraday_vwap',
  'detect_volume_surge',
  'get_intraday_quote',
  'get_intraday_kline',
  'get_market_summary',
  'get_futures_daily_ohlc',
  'get_put_call_ratio',
  'get_institutional_investors',
  'get_major_announcements',
  'get_abnormal_trading',
  'get_stock_daily_kline',
  'scan_daytrade_eligibility',
  'get_trading_calendar',
  'get_symbol_list',
  'get_pre_market_quote',
  'get_taifex_night',
  'get_us_market',
] as const;
export type ToolName = (typeof TOOL_CONTRACTS)[number];
