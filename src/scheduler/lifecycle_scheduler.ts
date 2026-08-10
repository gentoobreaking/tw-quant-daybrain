// 排程表（T005，§18.2 為真值）+ 生命週期排程器
// - 讀取 config/scheduler.yaml 之 phases / intraday.tick_sec
// - 環境變數覆寫：NO_ENTRY_AFTER（13:00）、FORCE_CLOSE_AT（13:20）優先於 YAML
// - Phase 觸發/結束皆寫入事件日誌（phase_start|phase_end）
// - 防重入：單一 Phase 不可重入；Phase 2 tick 循環與 Phase 3 觸發點互斥

import { EventLogger } from '../logging/event_logger.js';
import { hhmmInTaipei, todayInTaipei, isoInTaipei } from '../utils/time.js';

/** Phase 定義（config/scheduler.yaml 之 phases[]） */
export interface PhaseDef {
  name: string;
  time: string; // HH:MM
  end?: string; // HH:MM（Phase 2 用）
  tick_sec?: number; // Phase 2 用
  event?: string;
}

export interface SchedulerConfig {
  timezone: string;
  phases: PhaseDef[];
  intraday: { tick_sec: number };
}

/** 環境變數覆寫（§17.1：NO_ENTRY_AFTER / FORCE_CLOSE_AT 優先於 YAML） */
export interface SchedulerEnvOverrides {
  noEntryAfter?: string; // HH:MM
  forceCloseAt?: string; // HH:MM
}

/** 單一 Phase 之排程時點（由 scheduler.yaml 展開） */
export interface PhaseSchedule {
  name: string;
  /** 觸發時間 HH:MM */
  time: string;
  /** 結束時間 HH:MM（有 end 之 Phase，如 Phase 2） */
  end?: string;
  /** tick 週期秒數（Phase 2） */
  tick_sec?: number;
}

/** Phase 2 tick 循環狀態 */
export interface TickState {
  running: boolean;
  lastTickAt: string | null;
  tickCount: number;
}

export interface LifecycleSchedulerOptions {
  /** 事件日誌（phase_start|phase_end 寫入） */
  eventLogger: EventLogger;
  /** 目前時間函式（測試注入） */
  nowFn?: () => Date;
  /** tick 執行函式（Phase 2 每 tick 呼叫；測試注入） */
  onTick?: (phase: string, tick: number, now: Date) => Promise<void> | void;
  /** Phase 3 觸發點執行函式（測試注入） */
  onPhase3Trigger?: (phase: string, now: Date) => Promise<void> | void;
  /** Phase 0/1/4 執行函式（測試注入） */
  onPhase?: (phase: string, now: Date) => Promise<void> | void;
}

/**
 * 從 config/scheduler.yaml 原始內容展開排程表（§18.2 為真值）。
 * 環境變數覆寫：NO_ENTRY_AFTER → phase3_close_1300.time、FORCE_CLOSE_AT → phase3_close_1320.time
 */
export function buildPhaseSchedules(
  raw: SchedulerConfig | Record<string, unknown>,
  overrides: SchedulerEnvOverrides = {},
): PhaseSchedule[] {
  const cfg = (raw ?? {}) as SchedulerConfig;
  const phases = Array.isArray(cfg.phases) ? cfg.phases : [];
  const schedules: PhaseSchedule[] = phases.map((p) => ({
    name: p.name,
    time: p.time,
    end: p.end,
    tick_sec: p.tick_sec,
  }));

  // 環境變數覆寫（§17.1）
  if (overrides.noEntryAfter) {
    const target = schedules.find((s) => s.name === 'phase3_close_1300');
    if (target) target.time = overrides.noEntryAfter;
  }
  if (overrides.forceCloseAt) {
    const target = schedules.find((s) => s.name === 'phase3_close_1320');
    if (target) target.time = overrides.forceCloseAt;
  }
  return schedules;
}

/** 將 HH:MM 轉為分鐘數 */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export class LifecycleScheduler {
  readonly phases: PhaseSchedule[];
  readonly tickSec: number;
  private readonly eventLogger: EventLogger;
  private readonly nowFn: () => Date;
  private readonly onTick?: LifecycleSchedulerOptions['onTick'];
  private readonly onPhase3Trigger?: LifecycleSchedulerOptions['onPhase3Trigger'];
  private readonly onPhase?: LifecycleSchedulerOptions['onPhase'];

  /** 已觸發之 Phase（防重入） */
  private fired = new Set<string>();
  /** Phase 2 tick 循環狀態 */
  private tickState: TickState = { running: false, lastTickAt: null, tickCount: 0 };
  /** Phase 3 是否已觸發（與 Phase 2 互斥） */
  private phase3Fired = false;
  /** 今日日期（防跨日重排） */
  private currentDay: string;

  constructor(schedules: PhaseSchedule[], options: LifecycleSchedulerOptions) {
    this.phases = schedules;
    this.tickSec = schedules.find((s) => s.name === 'phase2_intraday')?.tick_sec ?? 10;
    this.eventLogger = options.eventLogger;
    this.nowFn = options.nowFn ?? (() => new Date());
    this.onTick = options.onTick;
    this.onPhase3Trigger = options.onPhase3Trigger;
    this.onPhase = options.onPhase;
    this.currentDay = todayInTaipei(this.nowFn());
  }

  /** 目前 tick 狀態（測試/監控） */
  getTickState(): TickState {
    return { ...this.tickState };
  }

  /** 已觸發之 Phase 清單（測試） */
  getFiredPhases(): string[] {
    return [...this.fired];
  }

  /** Phase 2 是否執行中 */
  isPhase2Running(): boolean {
    return this.tickState.running;
  }

  /** 是否已觸發 Phase 3（互斥檢查） */
  hasPhase3Fired(): boolean {
    return this.phase3Fired;
  }

  /**
   * 檢查並觸發到期之 Phase（以 Taipei 目前時間 vs 排程表）。
   * 非交易日不排程任何 Phase（由外部以 TradingCalendar.isTradingDay 判斷後再呼叫）。
   * 回傳本次觸發之 Phase 名稱清單。
   */
  checkAndFire(now: Date = this.nowFn()): string[] {
    const today = todayInTaipei(now);
    if (today !== this.currentDay) {
      // 跨日重置（防跨日重排）
      this.currentDay = today;
      this.fired.clear();
      this.phase3Fired = false;
      this.tickState = { running: false, lastTickAt: null, tickCount: 0 };
    }

    const hhmm = hhmmInTaipei(now);
    const nowMin = toMinutes(hhmm);
    const firedNow: string[] = [];

    // Phase 2（09:00–12:30，tick 10s）：時間窗內啟動 tick 循環；結束時間後停止
    const phase2 = this.phases.find((p) => p.name === 'phase2_intraday');
    if (phase2) {
      const startMin = toMinutes(phase2.time);
      const endMin = phase2.end ? toMinutes(phase2.end) : startMin;
      const inWindow = nowMin >= startMin && nowMin < endMin;

      // 離開 Phase 2 時間窗 → 結束 tick 循環並寫 phase_end
      if (!inWindow && this.tickState.running) {
        this.tickState.running = false;
        this.firePhase('phase2_intraday', now, 'end');
        firedNow.push('phase2_intraday:end');
      }

      if (inWindow && !this.tickState.running) {
        // 進入 Phase 2：觸發 phase_start、啟動 tick 循環（與 Phase 3 互斥）
        if (!this.phase3Fired) {
          this.tickState.running = true;
          this.tickState.tickCount = 0;
          this.firePhase('phase2_intraday', now, 'start');
          firedNow.push('phase2_intraday');
        }
      }

      // tick 循環執行（running 時每呼叫一次 checkAndFire 即為一個 tick）
      if (this.tickState.running && inWindow) {
        this.tickState.tickCount += 1;
        this.tickState.lastTickAt = isoInTaipei(now);
        void this.onTick?.('phase2_intraday', this.tickState.tickCount, now);
      }
    }

    // Phase 3 觸發點（11:30/12:30/13:00/13:10/13:15/13:20）
    const phase3Names = new Set([
      'phase3_close',
      'phase3_close_1230',
      'phase3_close_1300',
      'phase3_close_1310',
      'phase3_close_1315',
      'phase3_close_1320',
    ]);
    for (const p of this.phases) {
      if (!phase3Names.has(p.name)) continue;
      if (this.fired.has(p.name)) continue;
      if (nowMin >= toMinutes(p.time)) {
        this.fired.add(p.name);
        this.phase3Fired = true;
        this.firePhase(p.name, now, 'start');
        firedNow.push(p.name);
        // 註：Phase 3 觸發點為時間規則（停空訊/警示/強平等），不終止 Phase 2 tick 循環；
        // tick 循環僅由 Phase 2 時間窗（09:00–12:30）控制，離開時間窗即停止。
      }
    }

    // Phase 0 / 1 / 4 單次觸發
    for (const p of this.phases) {
      if (phase3Names.has(p.name) || p.name === 'phase2_intraday') continue;
      if (this.fired.has(p.name)) continue;
      if (nowMin >= toMinutes(p.time)) {
        this.fired.add(p.name);
        this.firePhase(p.name, now, 'start');
        firedNow.push(p.name);
      }
    }

    return firedNow;
  }

  /** 寫入 phase_start|phase_end 事件 + 執行對應回呼 */
  private firePhase(name: string, now: Date, kind: 'start' | 'end'): void {
    this.eventLogger.write(
      kind === 'start' ? 'phase_start' : 'phase_end',
      { phase: name, ts_iso: isoInTaipei(now) },
      now,
    );
    if (kind === 'start') {
      if (name === 'phase2_intraday') {
        // tick 循環由 checkAndFire 內啟動
      } else if (name.startsWith('phase3')) {
        void this.onPhase3Trigger?.(name, now);
      } else {
        void this.onPhase?.(name, now);
      }
    }
  }

  /** 手動觸發 Phase 2 單一 tick（測試用；等效於 checkAndFire 之 tick 執行） */
  async tickOnce(now: Date = this.nowFn()): Promise<void> {
    if (!this.tickState.running) return;
    this.tickState.tickCount += 1;
    this.tickState.lastTickAt = isoInTaipei(now);
    await this.onTick?.('phase2_intraday', this.tickState.tickCount, now);
  }
}
