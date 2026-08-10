// 風控系統與持倉狀態機（T008，§11）
// - 倉位規模（§11.1）：單筆風險＝權益×RISK_PER_TRADE（0.5% 上限 1%）、
//   股數＝風險÷(進場價−停損價)、單標的曝險≤權益 10%、MAX_POSITIONS
// - 狀態機（§11.2）：IDLE→SCANNING→ARMED→TRIGGERED→ENTERED→MANAGED→CLOSED→LOGGED
// - 出場規則（§11.3）：硬停損 > 目標價（部分獲利 50% + 移動停利）> 時間停損 > 假突破回收
// - 每日上限（§11.4）：-3% DAILY_LOCKOUT、連 3 筆停損→次日 50%、單日 10 筆
// - 時間限制（§11.5）：09:00–09:05 不進場、11:30 空方停開、12:30 警示、13:00 停發新訊/空方回補、
//   13:10 FORCE_FLAT_ALL、13:15 提醒、13:20 全平

import { timeToMinutes } from '../config/env.js';
import type { EventLogger } from '../logging/event_logger.js';

// ===== 持倉狀態（§11.2） =====

export type PositionState =
  | 'IDLE'
  | 'SCANNING'
  | 'ARMED'
  | 'TRIGGERED'
  | 'ENTERED'
  | 'MANAGED'
  | 'CLOSED'
  | 'LOGGED';

export type PositionAction = 'BUY_TO_OPEN' | 'SELL_TO_OPEN';

/** 合法狀態轉移（§11.2 狀態機） */
export const POSITION_STATE_TRANSITIONS: Record<PositionState, PositionState[]> = {
  IDLE: ['SCANNING'],
  SCANNING: ['ARMED', 'IDLE'],
  ARMED: ['TRIGGERED', 'SCANNING'],
  TRIGGERED: ['ENTERED', 'ARMED', 'IDLE'],
  ENTERED: ['MANAGED', 'CLOSED'],
  MANAGED: ['CLOSED'],
  CLOSED: ['LOGGED'],
  LOGGED: [],
};

/** 持倉（§14.3 Position；狀態機為單一真值來源，禁止外部直接修改欄位） */
export interface Position {
  position_id: string;
  signal_id: string;
  symbol: string;
  action: PositionAction;
  state: PositionState;
  entry_price: number;
  entry_ts: string;
  stop_loss_price: number;
  target_price?: number;
  shares: number;
  /** 移動停利：啟用後之停損價（MANAGED 階段） */
  trailing_stop_price?: number;
  /** 部分獲利已執行（50%） */
  partial_taken?: boolean;
  /** 已達目標價（R:R ≥ 2:1） */
  target_reached?: boolean;
  /** 假突破回收標記（§11.3 規則 4） */
  failed_breakout?: boolean;
}

/** Position repository 介面（T014 紙上交單介面實作此介面） */
export interface PositionRepository {
  get(id: string): Position | undefined;
  save(p: Position): void;
  all(): Position[];
}

export class InMemoryPositionRepository implements PositionRepository {
  private readonly store = new Map<string, Position>();

  get(id: string): Position | undefined {
    return this.store.get(id);
  }

  save(p: Position): void {
    this.store.set(p.position_id, p);
  }

  all(): Position[] {
    return [...this.store.values()];
  }
}

// ===== 出場規則（§11.3） =====

export type ExitReason =
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'TRAILING_STOP'
  | 'TIME_STOP'
  | 'FAILED_BREAKOUT'
  | 'FORCE_FLAT';

export interface RiskConfig {
  /** 單筆風險占權益比例（§11.1，預設 0.5%） */
  riskPerTrade: number;
  /** 單筆風險上限（1%） */
  maxRiskPerTrade: number;
  /** 同時最大持倉數（預設 2） */
  maxPositions: number;
  /** 單標的曝險上限（權益比例，預設 10%） */
  maxSymbolExposurePct: number;
  /** 每日最大虧損（權益 %，§11.4 預設 3） */
  maxDailyLossPct: number;
  /** 連續停損筆數（§11.4 預設 3） */
  consecutiveStopLossLimit: number;
  /** 單日最大交易次數（§11.4 預設 10） */
  maxDailyTrades: number;
  /** 硬停損幅度（多 -1.5% / 空 +1.5%，§11.3） */
  hardStopLossPct: number;
  /** 目標價 R:R（§11.3 預設 2:1） */
  targetRR: number;
  /** 部分獲利比例（§11.3 預設 50%） */
  partialTakePct: number;
  /** 移動停利啟用後回檔比例（多空不同，§6.4/§7.4） */
  trailingCallbackPct: number;
  /** 時間限制（HH:MM，§11.5） */
  timeLimits: {
    openBufferEnd: string; // 09:05 不進場
    shortStopNew: string; // 11:30 空方停開
    warnNoNew: string; // 12:30 警示
    hardStopNew: string; // 13:00 停發新訊/空方回補
    forceFlatAll: string; // 13:10
    forceFlatRemind: string; // 13:15
    forceFlatFinal: string; // 13:20 全平
  };
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  riskPerTrade: 0.005,
  maxRiskPerTrade: 0.01,
  maxPositions: 2,
  maxSymbolExposurePct: 0.10,
  maxDailyLossPct: 3.0,
  consecutiveStopLossLimit: 3,
  maxDailyTrades: 10,
  hardStopLossPct: 0.015,
  targetRR: 2,
  partialTakePct: 0.5,
  trailingCallbackPct: 0.01,
  timeLimits: {
    openBufferEnd: '09:05',
    shortStopNew: '11:30',
    warnNoNew: '12:30',
    hardStopNew: '13:00',
    forceFlatAll: '13:10',
    forceFlatRemind: '13:15',
    forceFlatFinal: '13:20',
  },
};

/** 每日風控狀態（§11.4） */
export interface DailyRiskState {
  realizedPnl: number;
  tradeCount: number;
  consecutiveStopLosses: number;
  /** DAILY_LOCKOUT：停新訊，僅管既有持倉出場 */
  dailyLockout: boolean;
  /** 連續停損達標 → 次日倉位規模 50% */
  nextDaySizeFactor: number;
}

export function createDailyRiskState(): DailyRiskState {
  return {
    realizedPnl: 0,
    tradeCount: 0,
    consecutiveStopLosses: 0,
    dailyLockout: false,
    nextDaySizeFactor: 1,
  };
}

// ===== 時間限制（§11.5） =====

export type TimeGateResult =
  | { allowed: true; reason?: undefined }
  | { allowed: false; reason: string };

/** 依 §11.5 時間限制判定是否可開新倉（time 為 HH:MM 字串） */
export function canOpenPosition(
  cfg: Pick<RiskConfig, 'timeLimits'>,
  time: string,
  action: PositionAction,
): TimeGateResult {
  const t = timeToMinutes(time);
  const lim = cfg.timeLimits;
  const openBufferEnd = timeToMinutes(lim.openBufferEnd);
  const shortStopNew = timeToMinutes(lim.shortStopNew);
  const warnNoNew = timeToMinutes(lim.warnNoNew);
  const hardStopNew = timeToMinutes(lim.hardStopNew);
  const forceFlatAll = timeToMinutes(lim.forceFlatAll);

  if (t < openBufferEnd) {
    return { allowed: false, reason: '09:00–09:05 開盤緩衝不進場' };
  }
  if (action === 'SELL_TO_OPEN' && t >= shortStopNew) {
    return { allowed: false, reason: '11:30 後空方停止開新空單' };
  }
  if (t >= warnNoNew) {
    return { allowed: false, reason: '12:30 警示：不再建立新倉位' };
  }
  if (t >= hardStopNew) {
    return { allowed: false, reason: '13:00 硬性停止發送新訊號' };
  }
  if (t >= forceFlatAll) {
    return { allowed: false, reason: '13:10 FORCE_FLAT_ALL：阻擋開倉' };
  }
  return { allowed: true };
}

/** 依 §11.5 時間規則取得持倉之強制出場指令（空方 13:00 回補、多方 13:10） */
export function forceFlatDirective(
  cfg: Pick<RiskConfig, 'timeLimits'>,
  time: string,
  action: PositionAction,
): { force: boolean; reason: string } {
  const t = timeToMinutes(time);
  const lim = cfg.timeLimits;
  const short = timeToMinutes(lim.hardStopNew); // 空方 13:00 強制回補
  const long = timeToMinutes(lim.forceFlatAll); // 多方 13:10 FORCE_FLAT_ALL
  if (action === 'SELL_TO_OPEN' && t >= short) {
    return { force: true, reason: '13:00 空單強制回補' };
  }
  if (action === 'BUY_TO_OPEN' && t >= long) {
    return { force: true, reason: '13:10 FORCE_FLAT_ALL 強制平倉' };
  }
  return { force: false, reason: '' };
}

// ===== 倉位規模（§11.1） =====

export interface PositionSizeInput {
  equity: number;
  entryPrice: number;
  stopLossPrice: number;
  /** 已持有之單標的曝險（元）；用於 ≤10% 檢查 */
  currentSymbolExposure?: number;
}

export interface PositionSizeResult {
  shares: number;
  riskNtd: number;
  /** 曝險金額（shares × entryPrice） */
  exposureNtd: number;
  /** 曝險占權益比例 */
  exposurePct: number;
  error?: string;
}

/** 倉位規模計算（§11.1） */
export function calculatePositionSize(
  cfg: Pick<RiskConfig, 'riskPerTrade' | 'maxRiskPerTrade' | 'maxSymbolExposurePct'>,
  input: PositionSizeInput,
): PositionSizeResult {
  const riskPerShare = Math.abs(input.entryPrice - input.stopLossPrice);
  if (riskPerShare <= 0) {
    return { shares: 0, riskNtd: 0, exposureNtd: 0, exposurePct: 0, error: '進場價=停損價，無法計算' };
  }

  const riskNtd = Math.min(
    input.equity * cfg.riskPerTrade,
    input.equity * cfg.maxRiskPerTrade,
  );
  const rawShares = Math.floor(riskNtd / riskPerShare);
  // 曝險 ≤ 權益 10%（含既有曝險）
  const exposureCap = input.equity * cfg.maxSymbolExposurePct;
  const currentExposure = input.currentSymbolExposure ?? 0;
  let shares = rawShares;
  while (shares > 0 && currentExposure + shares * input.entryPrice > exposureCap) {
    shares -= 1;
  }
  return {
    shares,
    riskNtd,
    exposureNtd: shares * input.entryPrice,
    exposurePct: (shares * input.entryPrice) / input.equity,
  };
}

// ===== 出場評估（§11.3） =====

export interface MarketSnapshot {
  price: number;
  vwap: number;
  dayHigh: number;
  /** 持倉期間最高價（多）／最低價（空），供移動停利 */
  extrema: number;
}

export interface ExitEvaluation {
  exit: boolean;
  reason?: ExitReason;
  /** 部分獲利（50%）時回傳 */
  partialTake?: boolean;
}

/** 依 §11.3 出場規則優先序評估持倉是否出場 */
export function evaluateExit(
  cfg: Pick<RiskConfig, 'hardStopLossPct' | 'targetRR' | 'partialTakePct' | 'trailingCallbackPct'>,
  p: Position,
  snap: MarketSnapshot,
): ExitEvaluation {
  const isLong = p.action === 'BUY_TO_OPEN';

  // 1. 硬停損（優先序 1）
  if (isLong) {
    // 多：虧損 -1.5% 或跌破 VWAP
    if (snap.price <= p.entry_price * (1 - cfg.hardStopLossPct)) {
      return { exit: true, reason: 'STOP_LOSS' };
    }
    if (snap.price < snap.vwap) {
      return { exit: true, reason: 'STOP_LOSS' };
    }
  } else {
    // 空：虧損 +1.5% 或站回 VWAP / 突破當日高點（§7.4）
    if (snap.price >= p.entry_price * (1 + cfg.hardStopLossPct)) {
      return { exit: true, reason: 'STOP_LOSS' };
    }
    if (snap.price > snap.vwap) {
      return { exit: true, reason: 'STOP_LOSS' };
    }
    if (snap.price >= snap.dayHigh) {
      return { exit: true, reason: 'STOP_LOSS' };
    }
  }

  // 2. 目標價 R:R ≥ 2:1（優先序 2；可部分獲利 50% + 移動停利）
  if (p.target_price !== undefined && !p.target_reached) {
    const reached = isLong
      ? snap.price >= p.target_price
      : snap.price <= p.target_price;
    if (reached) {
      // 第一次達標：部分獲利 50%（若尚未執行）
      if (!p.partial_taken) {
        return { exit: false, reason: 'TAKE_PROFIT', partialTake: true };
      }
      return { exit: true, reason: 'TAKE_PROFIT' };
    }
  }

  // 3. 移動停利（MANAGED 階段）
  if (p.trailing_stop_price !== undefined) {
    const hit = isLong
      ? snap.price <= p.trailing_stop_price
      : snap.price >= p.trailing_stop_price;
    if (hit) {
      return { exit: true, reason: 'TRAILING_STOP' };
    }
  }

  // 4. 假突破回收（優先序 4）
  if (p.failed_breakout) {
    return { exit: true, reason: 'FAILED_BREAKOUT' };
  }

  return { exit: false };
}

// ===== RiskManager（狀態機 + 每日風控） =====

export interface RiskManagerOptions {
  config: RiskConfig;
  repo: PositionRepository;
  eventLogger: EventLogger;
  /** 權益（帳戶） */
  equity: number;
  /** 人工確認（TRIGGERED→ENTERED；T014 介面）預設自動允許（紙上交單回報） */
  confirmEntry?: (p: Position) => Promise<boolean>;
  nowFn?: () => Date;
}

export class RiskManager {
  private readonly cfg: RiskConfig;
  private readonly repo: PositionRepository;
  private readonly events: EventLogger;
  private readonly equity: number;
  private readonly confirmEntry?: (p: Position) => Promise<boolean>;
  private readonly nowFn: () => Date;
  private daily: DailyRiskState;
  private seq = 0;

  constructor(opts: RiskManagerOptions) {
    this.cfg = opts.config;
    this.repo = opts.repo;
    this.events = opts.eventLogger;
    this.equity = opts.equity;
    this.confirmEntry = opts.confirmEntry;
    this.nowFn = opts.nowFn ?? (() => new Date());
    this.daily = createDailyRiskState();
  }

  /** 目前持倉（未平倉） */
  openPositions(): Position[] {
    return this.repo
      .all()
      .filter((p) => ['ENTERED', 'MANAGED'].includes(p.state));
  }

  /** 單標的曝險（元） */
  symbolExposure(symbol: string): number {
    return this.openPositions()
      .filter((p) => p.symbol === symbol)
      .reduce((sum, p) => sum + p.shares * p.entry_price, 0);
  }

  /** 每日風控是否允許開新倉（§11.4/§11.5） */
  canOpenNewPosition(action: PositionAction, time: string): TimeGateResult {
    if (this.daily.dailyLockout) {
      return { allowed: false, reason: 'DAILY_LOCKOUT：-3% 權益，停新訊' };
    }
    if (this.openPositions().length >= this.cfg.maxPositions) {
      return { allowed: false, reason: `已達 MAX_POSITIONS（${this.cfg.maxPositions}）` };
    }
    if (this.daily.tradeCount >= this.cfg.maxDailyTrades) {
      return { allowed: false, reason: `已達單日交易次數上限（${this.cfg.maxDailyTrades}）` };
    }
    return canOpenPosition(this.cfg, time, action);
  }

  /**
   * 建立持倉（SCANNING→ARMED→TRIGGERED 流程）
   * - SCANNING：訊號候選
   * - ARMED：觸發價設好
   * - TRIGGERED：價≥觸發價且評分≥門檻
   */
  armPosition(input: {
    signal_id: string;
    symbol: string;
    action: PositionAction;
    triggerPrice: number;
    stopLossPrice: number;
    targetPrice?: number;
  }): Position {
    const id = `P-${this.nowFn().toISOString().slice(0, 10)}-${String(++this.seq).padStart(2, '0')}`;
    const p: Position = {
      position_id: id,
      signal_id: input.signal_id,
      symbol: input.symbol,
      action: input.action,
      state: 'IDLE',
      entry_price: input.triggerPrice,
      entry_ts: this.nowFn().toISOString(),
      stop_loss_price: input.stopLossPrice,
      target_price: input.targetPrice,
      shares: 0,
    };
    this.transition(p, 'SCANNING');
    this.transition(p, 'ARMED');
    this.repo.save(p);
    return p;
  }

  /** TRIGGERED：價 ≥ 觸發價且評分 ≥ 門檻（§11.2） */
  trigger(p: Position, price: number, score: number, threshold: number): boolean {
    if (p.state !== 'ARMED') {
      throw new Error(`trigger: 狀態必須為 ARMED（目前 ${p.state}）`);
    }
    if (price < p.entry_price || score < threshold) {
      return false;
    }
    this.transition(p, 'TRIGGERED');
    this.repo.save(p);
    return true;
  }

  /**
   * 進場（TRIGGERED→ENTERED）
   * - 需人工確認或紙上交單回報（§1 原則 4，Human-in-the-loop；T014 提供介面）
   * - 進場時計算倉位規模（§11.1）
   */
  async enter(p: Position): Promise<boolean> {
    if (p.state !== 'TRIGGERED') {
      throw new Error(`enter: 狀態必須為 TRIGGERED（目前 ${p.state}）`);
    }
    if (this.confirmEntry) {
      const ok = await this.confirmEntry(p);
      if (!ok) {
        this.transition(p, 'ARMED'); // 人工拒絕 → 退回 ARMED
        this.repo.save(p);
        return false;
      }
    }
    const size = calculatePositionSize(this.cfg, {
      equity: this.equity,
      entryPrice: p.entry_price,
      stopLossPrice: p.stop_loss_price,
      currentSymbolExposure: this.symbolExposure(p.symbol),
    });
    if (size.error || size.shares <= 0) {
      return false;
    }
    p.shares = size.shares;
    this.transition(p, 'ENTERED');
    this.events.write('position_opened', {
      position_id: p.position_id,
      symbol: p.symbol,
      shares: p.shares,
      entry_price: p.entry_price,
    });
    this.daily.tradeCount += 1;
    this.repo.save(p);
    return true;
  }

  /** 進入 MANAGED（移動停利管理階段） */
  manage(p: Position): void {
    if (p.state !== 'ENTERED') {
      throw new Error(`manage: 狀態必須為 ENTERED（目前 ${p.state}）`);
    }
    // 啟用移動停利：多→成本價；空→放空成本價（§6.4/§7.4 剩餘 50% 啟動）
    p.trailing_stop_price = p.entry_price;
    if (!p.partial_taken) {
      p.partial_taken = true;
    }
    this.transition(p, 'MANAGED');
    this.repo.save(p);
  }

  /**
   * 出場評估 + 平倉（MANAGED/ENTERED → CLOSED）
   * 回傳出場結果；未出場回傳 null
   */
  evaluateAndClose(p: Position, snap: MarketSnapshot, time: string, extra: { pnlNtd?: number } = {}): ExitEvaluation | null {
    if (!['ENTERED', 'MANAGED'].includes(p.state)) {
      return null;
    }

    // 時間強制出場（優先序 3）
    const fd = forceFlatDirective(this.cfg, time, p.action);
    if (fd.force) {
      this.close(p, 'FORCE_FLAT', { reason: fd.reason, ...extra });
      return { exit: true, reason: 'FORCE_FLAT' };
    }

    const ev = evaluateExit(this.cfg, p, snap);
    if (ev.partialTake) {
      // 部分獲利 50%（§11.3 優先序 2）→ 剩餘 50% 進入 MANAGED 移動停利
      p.partial_taken = true;
      p.target_reached = true;
      p.trailing_stop_price = p.entry_price;
      this.transition(p, 'MANAGED');
      this.repo.save(p);
      return ev;
    }
    if (!ev.exit) {
      // 更新移動停利：多→追蹤最高價回檔；空→追蹤最低價反彈
      if (p.state === 'MANAGED' && p.trailing_stop_price !== undefined) {
        const isLong = p.action === 'BUY_TO_OPEN';
        const cb = this.cfg.trailingCallbackPct;
        if (isLong) {
          p.trailing_stop_price = Math.max(p.trailing_stop_price, snap.extrema * (1 - cb));
        } else {
          p.trailing_stop_price = Math.min(p.trailing_stop_price, snap.extrema * (1 + cb));
        }
        this.repo.save(p);
      }
      return null;
    }

    this.close(p, ev.reason ?? 'TAKE_PROFIT', extra);
    return ev;
  }

  /** 平倉（→CLOSED）：更新每日風控（§11.4） */
  close(p: Position, reason: ExitReason, extra: { reason?: string; pnlNtd?: number } = {}): void {
    if (p.state !== 'ENTERED' && p.state !== 'MANAGED') {
      throw new Error(`close: 狀態必須為 ENTERED/MANAGED（目前 ${p.state}）`);
    }
    const prev = p.state;
    this.events.write('position_closed', {
      position_id: p.position_id,
      reason,
      detail: extra.reason,
    });
    this.transition(p, 'CLOSED', { fromOverride: prev });

    // 每日風控（§11.4）
    const pnl = extra.pnlNtd ?? 0;
    this.daily.realizedPnl += pnl;
    if (reason === 'STOP_LOSS') {
      this.daily.consecutiveStopLosses += 1;
    } else {
      this.daily.consecutiveStopLosses = 0;
    }
    // 連 3 筆停損 → 次日倉位 50%
    if (this.daily.consecutiveStopLosses >= this.cfg.consecutiveStopLossLimit) {
      this.daily.nextDaySizeFactor = 0.5;
    }
    // -3% 權益 → DAILY_LOCKOUT（停新訊，僅管既有持倉出場）
    if (this.daily.realizedPnl <= -this.equity * (this.cfg.maxDailyLossPct / 100)) {
      if (!this.daily.dailyLockout) {
        this.daily.dailyLockout = true;
        this.events.write('daily_lockout', { reason: `日虧損達 -${this.cfg.maxDailyLossPct}% 權益` });
      }
    }
    this.repo.save(p);
  }

  /** 寫入 JournalEntry（CLOSED→LOGGED） */
  log(p: Position): void {
    if (p.state !== 'CLOSED') {
      throw new Error(`log: 狀態必須為 CLOSED（目前 ${p.state}）`);
    }
    this.transition(p, 'LOGGED');
    this.repo.save(p);
  }

  /** 每日狀態（§11.4） */
  dailyState(): DailyRiskState {
    return { ...this.daily };
  }

  private transition(p: Position, to: PositionState, opts: { fromOverride?: PositionState } = {}): void {
    const from = opts.fromOverride ?? p.state;
    const allowed = POSITION_STATE_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new Error(`非法狀態轉移 ${from} → ${to}`);
    }
    const prev = p.state;
    p.state = to;
    this.events.write('position_state_change', {
      position_id: p.position_id,
      from: prev,
      to,
    });
  }
}
