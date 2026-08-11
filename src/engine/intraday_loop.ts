// 盤中監控循環（T009，§4 Phase 2 + Phase 3）
// - 每 tick（10s）對觀察清單呼叫 get_intraday_vwap + detect_volume_surge（T002），
//   資料一律先過 T003 守門
// - 09:00–09:05 開盤緩衝：僅收集不進場（T008 時間限制連動）
// - Bias 白名單攔截（§4 Phase 2 步驟 4）：檢查 Briefing trading_plan.allowed_actions，
//   LONG_ONLY 日空方高分訊號於 blocked_actions 第一關攔截
// - 雙 tick 確認 → T007 評分 → SignalAdvice（§14.2）輸出
// - 多標的資金調度：同 tick 多檔觸發 → PriorityRankingEngine（T020；未完成以 stub 注入）
// - 假突破回收（§4 Phase 2 步驟 6）：確認後 3 分鐘內回落 VWAP 下方 → failed_breakout 事件
// - Phase 3 尾盤收斂：11:30/12:30/13:00/13:10/13:15/13:20 觸發點皆寫事件
// - LOCKOUT/DAILY_LOCKOUT 下停止新訊號但持續風控

import type { Envelope } from '../mcp/envelope.js';
import type { VwapResult, VolumeSurgeResult } from '../mcp/contracts.js';
import type { EventLogger } from '../logging/event_logger.js';
import type { FreshnessGate } from '../gate/freshness_gate.js';
import { isoInTaipei } from '../utils/time.js';
import {
  type ScoreInput,
  type ScoreResult,
  type SignalScoringEngine,
  type TickConfirmer,
  type SignalDirection,
} from './scoring.js';
import {
  type RiskManager,
  type PositionAction,
  type RiskConfig,
  DEFAULT_RISK_CONFIG,
  calculatePositionSize,
} from '../risk/risk_manager.js';

// ===== 依賴注入介面（T019/T020 完成前以 stub 注入） =====

/** Briefing 載入器（T019 完成前由測試 stub 注入） */
export interface BriefingProvider {
  /** 當日 trading_plan（無 briefing 時回傳 undefined → 視為無限制） */
  tradingPlan(symbol: string): { allowed_actions: PositionAction[]; blocked_actions: PositionAction[] } | undefined;
}

/** Priority Ranking Engine（T020 完成前由測試 stub 注入） */
export interface PriorityEngine {
  /** 同 tick 多檔觸發 → 依 Rank Score 排序派單；回傳排序後之 signal_id 清單 */
  rank(candidates: Array<{ signal_id: string; symbol: string; score: number }>): Promise<string[]>;
}

/** mcp 呼叫函式（T002 McpClient.call 之相容介面） */
export type McpCallFn = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<Envelope>;

// ===== SignalAdvice（§14.2） =====

export interface DataQuality {
  freshness: 'REALTIME_INTRADAY';
  fetched_lag_sec: number;
  is_cached: boolean;
}

export interface SignalAdvice {
  signal_id: string;
  ts: string;
  symbol: string;
  grade: string;
  score: number;
  score_breakdown: ScoreResult['breakdown'];
  strategy: string;
  recommended_entry: number;
  target_price: number;
  stop_loss_price: number;
  rr_ratio: number;
  position_size_shares: number;
  data_quality: DataQuality;
  expiry_ts: string;
}

// ===== Phase 3 觸發點（§4 Phase 3） =====

export interface Phase3Trigger {
  /** HH:MM 觸發時間 */
  time: string;
  /** 事件類型（皆寫入事件日誌） */
  event: 'short_stop_new' | 'no_new_position_warn' | 'hard_stop_new' | 'force_flat_warn' | 'force_flat_remind' | 'force_flat_final';
  /** 事件說明 */
  message: string;
}

export const PHASE3_TRIGGERS: Phase3Trigger[] = [
  { time: '11:30', event: 'short_stop_new', message: '11:30 停止發送新空單訊號' },
  { time: '12:30', event: 'no_new_position_warn', message: '12:30 警示：不再建立新倉位' },
  { time: '13:00', event: 'hard_stop_new', message: '13:00 硬性停止發送新買進/做多訊號' },
  { time: '13:10', event: 'force_flat_warn', message: '13:10 FORCE_FLAT_ALL：多方強制平倉警告' },
  { time: '13:15', event: 'force_flat_remind', message: '13:15 未平倉 → 最高等級強制平倉提醒' },
  { time: '13:20', event: 'force_flat_final', message: '13:20 強制全數平倉（當沖不留倉）' },
];

// ===== IntradayLoop =====

export interface IntradayLoopOptions {
  /** 觀察清單（T006 產出之 watchlist） */
  watchlist: string[];
  /** mcp 呼叫（T002） */
  call: McpCallFn;
  /** 守門（T003 FreshnessGate 實例） */
  gate: FreshnessGate;
  /** 事件日誌（T004） */
  events: EventLogger;
  /** 評分引擎（T007） */
  scoring: SignalScoringEngine;
  /** 雙 tick 確認器（T007） */
  ticker: TickConfirmer;
  /** 風控（T008） */
  risk: RiskManager;
  /** Briefing 載入器（T019；stub 注入） */
  briefing?: BriefingProvider;
  /** Priority Engine（T020；stub 注入） */
  priority?: PriorityEngine;
  /** 開盤緩衝結束（HH:MM，§11.5 09:05） */
  openBufferEnd?: string;
  /** 訊號過期分鐘數（§8.3 預設 5） */
  signalExpiryMin?: number;
  /** 假突破回收窗口（秒，§4 預設 180s） */
  failedBreakoutWindowSec?: number;
  /** 已觸發之 Phase 3 點（用於防重入） */
  firedPhase3?: Set<string>;
  /** 權益（SignalAdvice 倉位規模計算，§11.1） */
  equity?: number;
  /** 風控設定（預設 DEFAULT_RISK_CONFIG） */
  riskConfig?: RiskConfig;
  /** 時鐘（測試注入） */
  nowFn?: () => Date;
}

interface PendingSignal {
  signal_id: string;
  symbol: string;
  direction: SignalDirection;
  confirmedTs: Date;
  score: ScoreResult;
  entryPrice: number;
  stopLoss: number;
  target: number;
}

export class IntradayLoop {
  private readonly watchlist: string[];
  private readonly call: McpCallFn;
  private readonly gate: FreshnessGate;
  private readonly events: EventLogger;
  private readonly scoring: SignalScoringEngine;
  private readonly ticker: TickConfirmer;
  private readonly risk: RiskManager;
  private readonly briefing?: BriefingProvider;
  private readonly priority?: PriorityEngine;
  private readonly openBufferEnd: string;
  private readonly signalExpiryMin: number;
  private readonly failedBreakoutWindowSec: number;
  private readonly equity: number;
  private readonly riskConfig: RiskConfig;
  private readonly firedPhase3: Set<string>;
  private readonly nowFn: () => Date;

  /** 已確認待進場之訊號（假突破回收追蹤用） */
  private readonly pending = new Map<string, PendingSignal>();

  constructor(opts: IntradayLoopOptions) {
    this.watchlist = opts.watchlist;
    this.call = opts.call;
    this.gate = opts.gate;
    this.events = opts.events;
    this.scoring = opts.scoring;
    this.ticker = opts.ticker;
    this.risk = opts.risk;
    this.briefing = opts.briefing;
    this.priority = opts.priority;
    this.openBufferEnd = opts.openBufferEnd ?? '09:05';
    this.signalExpiryMin = opts.signalExpiryMin ?? 5;
    this.failedBreakoutWindowSec = opts.failedBreakoutWindowSec ?? 180;
    this.firedPhase3 = opts.firedPhase3 ?? new Set();
    this.equity = opts.equity ?? 1_000_000;
    this.riskConfig = opts.riskConfig ?? DEFAULT_RISK_CONFIG;
    this.nowFn = opts.nowFn ?? (() => new Date());
  }

  /** 目前台北時間 HH:MM:SS */
  private nowTime(): string {
    return this.nowFn().toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false });
  }

  /** 分鐘字串比較（HH:MM） */
  private hhmm(): string {
    return this.nowTime().slice(0, 5);
  }

  /** signal_id：YYYYMMDD-HHMM-ssSSS（§14.2 格式） */
  private makeSignalId(now: Date): string {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${pad(now.getSeconds())}${String(now.getMilliseconds()).padStart(3, '0')}`;
  }

  /** 開盤緩衝內（僅收集不進場） */
  isOpenBuffer(): boolean {
    return this.hhmm() < this.openBufferEnd;
  }

  /** Phase 3 已觸發（防重入） */
  isPhase3Fired(event: string): boolean {
    return this.firedPhase3.has(event);
  }

  /** 判定並觸發 Phase 3 事件（§4 Phase 3，每次 tick 檢查） */
  checkPhase3(now: Date = this.nowFn()): void {
    const hhmm = this.hhmm();
    for (const t of PHASE3_TRIGGERS) {
      if (hhmm >= t.time && !this.firedPhase3.has(t.event)) {
        this.firedPhase3.add(t.event);
        // Phase 3 觸發點以 phase_end + trigger 欄位記錄（§14.4）
        this.events.write('phase_end', {
          phase: 3,
          trigger: t.event,
          detail: t.message,
        }, now);
      }
    }
  }

  /** 守門 + 節流：同 tick 內同 symbol 不得重複呼叫同工具 */
  private async fetchVwap(symbol: string, perTick: Set<string>): Promise<VwapResult | null> {
    const key = `vwap:${symbol}`;
    if (perTick.has(key)) return null;
    perTick.add(key);
    const env = await this.call('get_intraday_vwap', { symbol });
    const g = this.gate.check(env, 'INTRADAY_SIGNAL', { symbol, now: this.nowFn() });
    if (!g.passed) {
      this.events.write('freshness_gate_fail', {
        symbol,
        cause: g.cause ?? 'gate_fail',
      }, this.nowFn());
      return null;
    }
    return env.data as unknown as VwapResult;
  }

  private async fetchSurge(symbol: string, perTick: Set<string>): Promise<VolumeSurgeResult | null> {
    const key = `surge:${symbol}`;
    if (perTick.has(key)) return null;
    perTick.add(key);
    const env = await this.call('detect_volume_surge', { symbol });
    const g = this.gate.check(env, 'INTRADAY_SIGNAL', { symbol, now: this.nowFn() });
    if (!g.passed) {
      this.events.write('freshness_gate_fail', {
        symbol,
        cause: g.cause ?? 'gate_fail',
      }, this.nowFn());
      return null;
    }
    return env.data as unknown as VolumeSurgeResult;
  }

  /** 盤中循環（§4 Phase 2）：每 tick（10s）呼叫 */
  async tick(now: Date = this.nowFn()): Promise<SignalAdvice[]> {
    // Phase 3 觸發點（每次 tick 檢查）
    this.checkPhase3();

    // 守門 LOCKOUT：全系統停新訊
    if (this.gate.getState() === 'LOCKOUT') {
      return [];
    }

    const perTick = new Set<string>();
    const advices: SignalAdvice[] = [];
    const triggeredThisTick: Array<{ signal_id: string; symbol: string; score: number }> = [];

    for (const symbol of this.watchlist) {
      // 同 tick 內同 symbol 節流由 perTick 處理
      const [vwapRes, surgeRes] = await Promise.all([
        this.fetchVwap(symbol, perTick),
        this.fetchSurge(symbol, perTick),
      ]);
      if (!vwapRes || !surgeRes) continue;

      // 雙 tick 確認（§4 步驟 3）
      const confirmed = this.ticker.confirm(symbol);
      if (!confirmed) continue;

      // 過期重評：確認後 5 分鐘未觸發 → 重新評分
      const expired = this.ticker.isExpired(symbol, this.signalExpiryMin, now);
      if (expired) {
        this.events.write('signal_expired', { signal_id: this.makeSignalId(now), symbol }, now);
        continue;
      }

      // 假突破回收（§4 步驟 6）：已確認訊號 3 分鐘內回落 VWAP 下方 → 取消 + failed_breakout
      const pendingSig = this.pending.get(symbol);
      if (pendingSig) {
        const ageSec = (now.getTime() - pendingSig.confirmedTs.getTime()) / 1000;
        if (ageSec <= this.failedBreakoutWindowSec && vwapRes.current_price !== undefined && vwapRes.current_price < vwapRes.vwap) {
          this.pending.delete(symbol);
          this.events.write('failed_breakout', { signal_id: pendingSig.signal_id, symbol }, now);
          continue;
        }
        if (ageSec > this.failedBreakoutWindowSec) {
          this.pending.delete(symbol); // 超過窗口不再回收
        }
      }

      // 評分輸入（§8.2）
      const direction: SignalDirection = surgeRes.volumeSurgeType === 'BEARISH_BREAKDOWN' ? 'SHORT' : 'LONG';
      const input: ScoreInput = {
        direction,
        price: vwapRes.current_price ?? vwapRes.vwap,
        vwap: vwapRes.vwap,
        volumeSurgeRatio: surgeRes.volumeSurgeRatio ?? 0,
        volumeSurgeType: (surgeRes.volumeSurgeType as ScoreInput['volumeSurgeType']) ?? 'NEUTRAL',
        dayHigh: vwapRes.high,
        dayLow15m: vwapRes.low,
        taifexTrend: 'NEUTRAL', // 大盤方向由 T017/T018 提供；此處中性
        restriction: false,
      };

      // 開盤緩衝：僅收集不進場（§4 步驟 1）
      const action: PositionAction = direction === 'SHORT' ? 'SELL_TO_OPEN' : 'BUY_TO_OPEN';
      if (this.isOpenBuffer()) {
        continue; // 緩衝期不產出建議
      }

      // T008 時間限制 + 每日風控（§11.4/§11.5）
      const gate = this.risk.canOpenNewPosition(action, this.hhmm());
      if (!gate.allowed) {
        continue;
      }

      // Bias 白名單攔截（§4 步驟 4）：LONG_ONLY 日空方訊號於 blocked_actions 第一關攔截
      if (this.briefing) {
        const plan = this.briefing.tradingPlan(symbol);
        if (plan && plan.blocked_actions.includes(action)) {
          continue; // 攔截
        }
      }

      // 評分（T007）
      const result = this.scoring.score(input);
      if (!result.shouldEnter) {
        continue;
      }

      // 觸發價 = 昨日高點 / 站穩 VWAP（T006 已算 triggerPrice；此處以 VWAP 為保守觸發）
      const entryPrice = Math.max(vwapRes.current_price ?? vwapRes.vwap, vwapRes.vwap);
      const stopLoss = direction === 'LONG' ? entryPrice * 0.985 : entryPrice * 1.015;
      const target = direction === 'LONG' ? entryPrice * 1.03 : entryPrice * 0.97;
      const rrRatio = direction === 'LONG'
        ? (target - entryPrice) / (entryPrice - stopLoss)
        : (entryPrice - target) / (stopLoss - entryPrice);

      // 倉位規模（§11.1，T008）
      const size = calculatePositionSize(this.riskConfig, {
        equity: this.equity,
        entryPrice,
        stopLossPrice: stopLoss,
      }).shares;

      // 記錄待進場（假突破回收追蹤）
      const signalId = this.makeSignalId(now);
      this.pending.set(symbol, {
        signal_id: signalId,
        symbol,
        direction,
        confirmedTs: now,
        score: result,
        entryPrice,
        stopLoss,
        target,
      });

      triggeredThisTick.push({ signal_id: signalId, symbol, score: result.total });

      const advice: SignalAdvice = {
        signal_id: signalId,
        ts: isoInTaipei(now),
        symbol,
        grade: result.grade,
        score: result.total,
        score_breakdown: result.breakdown,
        strategy: direction === 'LONG' ? 'VWAP_SURGE_LONG' : 'BULL_TRAP_VWAP_SHORT',
        recommended_entry: entryPrice,
        target_price: target,
        stop_loss_price: stopLoss,
        rr_ratio: Math.round(rrRatio * 10) / 10,
        position_size_shares: size,
        data_quality: { freshness: 'REALTIME_INTRADAY', fetched_lag_sec: 0, is_cached: false },
        expiry_ts: isoInTaipei(new Date(now.getTime() + this.signalExpiryMin * 60_000)),
      };
      advices.push(advice);
    }

    // 多標的資金調度（§4 步驟 5）：同 tick 多檔觸發 → PriorityRankingEngine（T020）
    if (triggeredThisTick.length > 1 && this.priority) {
      const ranked = await this.priority.rank(triggeredThisTick);
      const rankedSet = new Set(ranked);
      advices.sort((a, b) => {
        const ia = rankedSet.has(a.signal_id) ? ranked.indexOf(a.signal_id) : 999;
        const ib = rankedSet.has(b.signal_id) ? ranked.indexOf(b.signal_id) : 999;
        return ia - ib;
      });
    }

    // 寫入 signal_issued 事件（§14.4，供 T010 統計）
    for (const a of advices) {
      this.events.write('signal_issued', {
        signal_id: a.signal_id,
        symbol: a.symbol,
        score: a.score,
        grade: a.grade,
        strategy: a.strategy,
        // 執行計劃（§6.5）：進場/目標/停損/風險報酬比/倉位，供模擬盤與回放檢視
        recommended_entry: a.recommended_entry,
        target_price: a.target_price,
        stop_loss_price: a.stop_loss_price,
        rr_ratio: a.rr_ratio,
        position_size_shares: a.position_size_shares,
      }, this.nowFn());
    }

    return advices;
  }

  /** 確認訊號後 3 分鐘內回落 VWAP 下方 → 手動觸發回收（供測試/外部呼叫） */
  manualFailedBreakout(symbol: string): void {
    const p = this.pending.get(symbol);
    if (p) {
      this.pending.delete(symbol);
      this.events.write('failed_breakout', { signal_id: p.signal_id, symbol }, this.nowFn());
    }
  }
}
