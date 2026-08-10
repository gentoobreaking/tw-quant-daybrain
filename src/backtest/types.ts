// 回測資料契約（§12.2）——T021 DataLoader 與 T022 Simulator 共用

/** 1 分鐘 K 線（§12.2 MinuteBar） */
export interface MinuteBar {
  symbol: string;
  /** ISO String，e.g. "2026-07-31T09:15:00+08:00" */
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 當分鐘成交張數 */
  volume: number;
}

/** 成交紀錄（§12.2 TradeRecord） */
export interface TradeRecord {
  tradeId: string;
  symbol: string;
  action: 'BUY_TO_OPEN' | 'SELL_TO_OPEN';
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  shares: number;
  /** 扣除稅費後的淨利潤 */
  pnlNtd: number;
  exitReason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP' | 'FORCE_FLAT';
  rankScoreAtEntry: number;
}

/** 持倉（§12.4 ActivePosition；v2.1 forceFlatBy 多空不同） */
export interface ActivePosition {
  symbol: string;
  action: 'BUY_TO_OPEN' | 'SELL_TO_OPEN';
  entryPrice: number;
  entryTime: string;
  shares: number;
  allocatedCapital: number;
  stopLossPrice: number;
  targetPrice1: number;
  highestPriceSinceEntry: number;
  lowestPriceSinceEntry: number;
  rankScore: number;
  /** v2.1：取自對應 briefing.trading_plan.active_window.force_flat_by（多空不同，§7.4/§11.5） */
  forceFlatBy: string;
}
