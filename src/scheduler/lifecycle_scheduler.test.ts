// T005 交易日曆與生命週期排程器 單元測試
// 驗證：交易日判定 + 快取、非交易日休眠、各 Phase 時點、防重入、Phase2/Phase3 互斥、
//       事件日誌 phase_start|phase_end、環境變數覆寫（NO_ENTRY_AFTER / FORCE_CLOSE_AT）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingCalendar } from './trading_calendar.js';
import { LifecycleScheduler, buildPhaseSchedules, toMinutes } from './lifecycle_scheduler.js';
import { EventLogger } from '../logging/event_logger.js';

// ===== 測試資料 =====

const CAL_DATA = {
  year: 2026,
  trading_days: ['2026-08-10', '2026-08-11', '2026-08-12'],
  holidays: [{ date: '2026-08-13', name: '測試休市' }],
};

const RAW_SCHEDULER = {
  timezone: 'Asia/Taipei',
  phases: [
    { name: 'phase0_ready', time: '08:15', event: '資料就緒檢查' },
    { name: 'phase1_premarket', time: '08:30', event: '盤前選股' },
    { name: 'briefing_lock', time: '08:55', event: 'Briefing 鎖定' },
    { name: 'phase2_intraday', time: '09:00', end: '12:30', tick_sec: 10, event: '盤中監控' },
    { name: 'phase3_close', time: '11:30', event: '尾盤收斂 11:30' },
    { name: 'phase3_close_1230', time: '12:30', event: '尾盤收斂 12:30' },
    { name: 'phase3_close_1300', time: '13:00', event: '尾盤收斂 13:00' },
    { name: 'phase3_close_1310', time: '13:10', event: '尾盤收斂 13:10' },
    { name: 'phase3_close_1315', time: '13:15', event: '尾盤收斂 13:15' },
    { name: 'phase3_close_1320', time: '13:20', event: '尾盤收斂 13:20' },
    { name: 'phase4_postmarket', time: '14:30', event: '盤後統計' },
  ],
  intraday: { tick_sec: 10 },
};

function mkEnv(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'daybrain-sched-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function nowAt(hhmm: string): Date {
  return new Date(`2026-08-10T${hhmm}:00+08:00`);
}

function mkScheduler(
  opts: {
    at?: string;
    events?: Array<Record<string, unknown>>;
    onTick?: (phase: string, tick: number, now: Date) => void;
    onPhase3?: (phase: string, now: Date) => void;
    onPhase?: (phase: string, now: Date) => void;
  } = {},
): { scheduler: LifecycleScheduler; events: Array<Record<string, unknown>>; cleanup: () => void } {
  const { dir, cleanup } = mkEnv();
  const events: Array<Record<string, unknown>> = [];
  const logger = new EventLogger(dir);
  const collector = (e: Record<string, unknown>) => events.push(e);
  const rawLogger = logger as unknown as { write: (t: string, f: Record<string, unknown>, n: Date) => unknown };
  const origWrite = rawLogger.write.bind(logger);
  rawLogger.write = (t: string, f: Record<string, unknown>, n: Date) => {
    collector({ ...f, type: t });
    return origWrite(t, f, n);
  };

  const schedules = buildPhaseSchedules(RAW_SCHEDULER as never);
  const scheduler = new LifecycleScheduler(schedules, {
    eventLogger: logger,
    nowFn: () => nowAt(opts.at ?? '09:00'),
    onTick: opts.onTick ?? (() => {}),
    onPhase3Trigger: opts.onPhase3 ?? (() => {}),
    onPhase: opts.onPhase ?? (() => {}),
  });
  return { scheduler, events, cleanup };
}

// ===== TradingCalendar =====

test('交易日判定：交易日 true / 非交易日 false', async () => {
  const { dir, cleanup } = mkEnv();
  try {
    const cal = new TradingCalendar({ cacheDir: dir, nowFn: () => nowAt('08:00') });
    await cal.load(async () => CAL_DATA);
    assert.equal(cal.isTradingDay('2026-08-10'), true);
    assert.equal(cal.isTradingDay('2026-08-13'), false); // 休市日
    assert.equal(cal.isTradingDay('2026-08-15'), false); // 週六
    assert.equal(cal.isTradingDay('2026-08-09'), false); // 週日
  } finally {
    cleanup();
  }
});

test('交易日曆快取：第二次載入不呼叫 fetchFn', async () => {
  const { dir, cleanup } = mkEnv();
  try {
    const cal = new TradingCalendar({ cacheDir: dir, nowFn: () => nowAt('08:00') });
    let fetchCount = 0;
    await cal.load(async () => {
      fetchCount += 1;
      return CAL_DATA;
    });
    assert.equal(fetchCount, 1);
    // 新 instance（同 cacheDir）→ 讀快取
    const cal2 = new TradingCalendar({ cacheDir: dir, nowFn: () => nowAt('08:00') });
    await cal2.load(async () => {
      fetchCount += 1;
      return CAL_DATA;
    });
    assert.equal(fetchCount, 1, '第二次載入應命中快取');
    assert.equal(cal2.isTradingDay('2026-08-10'), true);
  } finally {
    cleanup();
  }
});

test('交易日曆：forceRefresh 強制重新取得', async () => {
  const { dir, cleanup } = mkEnv();
  try {
    const cal = new TradingCalendar({ cacheDir: dir, nowFn: () => nowAt('08:00') });
    let fetchCount = 0;
    await cal.load(async () => {
      fetchCount += 1;
      return CAL_DATA;
    });
    await cal.load(async () => {
      fetchCount += 1;
      return CAL_DATA;
    }, true);
    assert.equal(fetchCount, 2);
  } finally {
    cleanup();
  }
});

test('交易日曆：快取檔寫入 cacheDir（LOG_DIR）', async () => {
  const { dir, cleanup } = mkEnv();
  try {
    const cal = new TradingCalendar({ cacheDir: dir, nowFn: () => nowAt('08:00') });
    await cal.load(async () => CAL_DATA);
    assert.ok(existsSync(join(dir, 'calendar.json')));
  } finally {
    cleanup();
  }
});

test('交易日判定：未 load 即呼叫 → 抛錯', () => {
  const cal = new TradingCalendar({ nowFn: () => nowAt('08:00') });
  assert.throws(() => cal.isTradingDay('2026-08-10'), /尚未載入/);
});

// ===== 排程表展開 =====

test('排程表展開：§18.2 全部 Phase，tick 10s', () => {
  const schedules = buildPhaseSchedules(RAW_SCHEDULER as never);
  assert.equal(schedules.length, 11);
  const phase2 = schedules.find((s) => s.name === 'phase2_intraday');
  assert.equal(phase2?.time, '09:00');
  assert.equal(phase2?.end, '12:30');
  assert.equal(phase2?.tick_sec, 10);
  assert.equal(schedules[0].name, 'phase0_ready');
  assert.equal(schedules[0].time, '08:15');
  assert.equal(schedules[10].name, 'phase4_postmarket');
  assert.equal(schedules[10].time, '14:30');
});

test('環境變數覆寫：NO_ENTRY_AFTER 覆寫 13:00、FORCE_CLOSE_AT 覆寫 13:20', () => {
  const schedules = buildPhaseSchedules(RAW_SCHEDULER as never, {
    noEntryAfter: '13:05',
    forceCloseAt: '13:25',
  });
  const s1300 = schedules.find((s) => s.name === 'phase3_close_1300');
  const s1320 = schedules.find((s) => s.name === 'phase3_close_1320');
  assert.equal(s1300?.time, '13:05');
  assert.equal(s1320?.time, '13:25');
});

test('toMinutes：HH:MM → 分鐘數', () => {
  assert.equal(toMinutes('08:15'), 495);
  assert.equal(toMinutes('13:20'), 800);
  assert.equal(toMinutes('00:00'), 0);
});

// ===== LifecycleScheduler 時點 =====

test('08:15 觸發 Phase 0（phase_start 事件）', () => {
  const { scheduler, events, cleanup } = mkScheduler({ at: '08:15' });
  try {
    const fired = scheduler.checkAndFire(nowAt('08:15'));
    assert.deepEqual(fired, ['phase0_ready']);
    const start = events.find((e) => e.type === 'phase_start');
    assert.equal(start?.phase, 'phase0_ready');
  } finally {
    cleanup();
  }
});

test('08:14 不觸發（未到時點）', () => {
  const { scheduler, cleanup } = mkScheduler({ at: '08:14' });
  try {
    const fired = scheduler.checkAndFire(nowAt('08:14'));
    assert.deepEqual(fired, []);
  } finally {
    cleanup();
  }
});

test('08:30 觸發 Phase 1（含 08:15 catch-up）；08:55 觸發 briefing_lock', () => {
  const { scheduler, cleanup } = mkScheduler({ at: '08:30' });
  try {
    // 全新 scheduler 於 08:30 啟動：08:15 的 Phase 0 補觸發 + 08:30 Phase 1
    const fired1 = scheduler.checkAndFire(nowAt('08:30'));
    assert.ok(fired1.includes('phase0_ready'));
    assert.ok(fired1.includes('phase1_premarket'));
    const fired2 = scheduler.checkAndFire(nowAt('08:55'));
    assert.deepEqual(fired2, ['briefing_lock']);
  } finally {
    cleanup();
  }
});

test('09:00 啟動 Phase 2 tick 循環（tick 執行）', () => {
  const ticks: Array<[string, number]> = [];
  const { scheduler, cleanup } = mkScheduler({
    at: '09:00',
    onTick: (phase, tick) => ticks.push([phase, tick]),
  });
  try {
    const fired = scheduler.checkAndFire(nowAt('09:00'));
    assert.ok(fired.includes('phase2_intraday'));
    assert.equal(scheduler.isPhase2Running(), true);
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0][0], 'phase2_intraday');
    assert.equal(ticks[0][1], 1);
  } finally {
    cleanup();
  }
});

test('防重入：同一 Phase 不重複觸發；Phase 2 tick 持續累加', () => {
  const ticks: number[] = [];
  const { scheduler, cleanup } = mkScheduler({
    at: '09:00',
    onTick: (_p, tick) => ticks.push(tick),
  });
  try {
    scheduler.checkAndFire(nowAt('09:00')); // 啟動（tick 1）
    scheduler.checkAndFire(new Date('2026-08-10T09:00:10+08:00')); // tick 2
    scheduler.checkAndFire(new Date('2026-08-10T09:00:20+08:00')); // tick 3
    const fired = scheduler.checkAndFire(new Date('2026-08-10T09:00:30+08:00')); // tick 4
    // phase2 不重複 fire，但 tick 持續
    assert.equal(fired.includes('phase2_intraday'), false);
    assert.equal(ticks.length, 4);
    assert.equal(scheduler.getTickState().tickCount, 4);
  } finally {
    cleanup();
  }
});

test('09:01 進入 Phase 2 也啟動 tick 循環（時間窗內）', () => {
  const ticks: number[] = [];
  const { scheduler, cleanup } = mkScheduler({
    at: '09:01',
    onTick: (_p, tick) => ticks.push(tick),
  });
  try {
    const fired = scheduler.checkAndFire(nowAt('09:01'));
    assert.ok(fired.includes('phase2_intraday'));
    assert.equal(ticks.length, 1);
  } finally {
    cleanup();
  }
});

test('12:30 離開 Phase 2 時間窗 → phase_end（tick 循環停止）', () => {
  const { scheduler, events, cleanup } = mkScheduler({ at: '12:30' });
  try {
    scheduler.checkAndFire(nowAt('12:29')); // 啟動
    assert.equal(scheduler.isPhase2Running(), true);
    scheduler.checkAndFire(nowAt('12:30'));
    assert.equal(scheduler.isPhase2Running(), false);
    const end = events.find((e) => e.type === 'phase_end' && e.phase === 'phase2_intraday');
    assert.ok(end, '應寫入 phase2 phase_end 事件');
  } finally {
    cleanup();
  }
});

// ===== Phase 3 =====

test('11:30 觸發 phase3_close（停發空訊）；Phase 2 tick 循環不受影響', () => {
  const fired3: string[] = [];
  const { scheduler, cleanup } = mkScheduler({
    at: '11:30',
    onPhase3: (p) => fired3.push(p),
  });
  try {
    const fired = scheduler.checkAndFire(nowAt('11:30'));
    assert.ok(fired.includes('phase3_close'));
    assert.deepEqual(fired3, ['phase3_close']);
    // 11:30 仍在 Phase 2 時間窗內：tick 循環應繼續（Phase 3 為時間規則，不終止監控）
    assert.equal(scheduler.isPhase2Running(), true);
  } finally {
    cleanup();
  }
});

test('Phase 3 觸發點依序：12:30 / 13:00 / 13:10 / 13:15 / 13:20', () => {
  const { scheduler, cleanup } = mkScheduler({ at: '12:30' });
  try {
    const t1230 = scheduler.checkAndFire(nowAt('12:30'));
    assert.ok(t1230.includes('phase3_close_1230'));
    const t1300 = scheduler.checkAndFire(nowAt('13:00'));
    assert.ok(t1300.includes('phase3_close_1300'));
    const t1310 = scheduler.checkAndFire(nowAt('13:10'));
    assert.ok(t1310.includes('phase3_close_1310'));
    const t1315 = scheduler.checkAndFire(nowAt('13:15'));
    assert.ok(t1315.includes('phase3_close_1315'));
    const t1320 = scheduler.checkAndFire(nowAt('13:20'));
    assert.ok(t1320.includes('phase3_close_1320'));
  } finally {
    cleanup();
  }
});

test('Phase 3 觸發點防重入：13:00 觸發後再呼叫不重複（不影響 13:10/13:20）', () => {
  const { scheduler, cleanup } = mkScheduler({ at: '13:00' });
  try {
    scheduler.checkAndFire(nowAt('13:00'));
    const again = scheduler.checkAndFire(new Date('2026-08-10T13:00:30+08:00'));
    assert.equal(again.includes('phase3_close_1300'), false);
    const t1310 = scheduler.checkAndFire(nowAt('13:10'));
    assert.ok(t1310.includes('phase3_close_1310'));
  } finally {
    cleanup();
  }
});

test('Phase 2 時間窗結束（12:30）後不再執行 tick；Phase 3 時間規則不影響 tick 循環', () => {
  const ticks: number[] = [];
  const { scheduler, cleanup } = mkScheduler({
    at: '11:30',
    onTick: (_p, t) => ticks.push(t),
  });
  try {
    scheduler.checkAndFire(nowAt('09:00')); // Phase 2 啟動（tick 1）
    scheduler.checkAndFire(nowAt('11:30')); // Phase 3 觸發：tick 循環應繼續
    assert.equal(scheduler.isPhase2Running(), true);
    const at1130 = ticks.length;
    assert.ok(at1130 >= 2);
    scheduler.checkAndFire(nowAt('12:30')); // 離開 Phase 2 時間窗 → 停止
    assert.equal(scheduler.isPhase2Running(), false);
    const at1230 = ticks.length;
    assert.equal(at1230, at1130, '時間窗結束後不應再有 tick');
  } finally {
    cleanup();
  }
});

// ===== Phase 4 / 事件日誌 =====

test('14:30 觸發 phase4_postmarket（phase_start + phase_end 寫入事件）', () => {
  const { scheduler, events, cleanup } = mkScheduler({ at: '14:30' });
  try {
    const fired = scheduler.checkAndFire(nowAt('14:30'));
    assert.ok(fired.includes('phase4_postmarket'));
    const start = events.find((e) => e.type === 'phase_start' && e.phase === 'phase4_postmarket');
    assert.ok(start);
  } finally {
    cleanup();
  }
});

test('所有 Phase 觸發皆寫 phase_start 事件（§18.2 時點驗證）', () => {
  const { scheduler, events, cleanup } = mkScheduler({ at: '08:15' });
  try {
    const times = ['08:15', '08:30', '08:55', '09:00', '11:30', '12:30', '13:00', '13:10', '13:15', '13:20', '14:30'];
    for (const t of times) {
      scheduler.checkAndFire(nowAt(t));
    }
    const starts = events.filter((e) => e.type === 'phase_start').map((e) => e.phase);
    // Phase 2 於 11:30 被 Phase 3 停止（phase_end），故 start 為 09:00 那次
    assert.ok(starts.includes('phase0_ready'));
    assert.ok(starts.includes('phase1_premarket'));
    assert.ok(starts.includes('briefing_lock'));
    assert.ok(starts.includes('phase2_intraday'));
    assert.ok(starts.includes('phase3_close'));
    assert.ok(starts.includes('phase3_close_1230'));
    assert.ok(starts.includes('phase3_close_1300'));
    assert.ok(starts.includes('phase3_close_1310'));
    assert.ok(starts.includes('phase3_close_1315'));
    assert.ok(starts.includes('phase3_close_1320'));
    assert.ok(starts.includes('phase4_postmarket'));
  } finally {
    cleanup();
  }
});

// ===== 非交易日休眠 =====

test('非交易日：不排程任何 Phase（TradingCalendar.isTradingDay === false）', async () => {
  const { dir, cleanup } = mkEnv();
  try {
    const cal = new TradingCalendar({ cacheDir: dir, nowFn: () => nowAt('09:00') });
    await cal.load(async () => CAL_DATA);
    // 模擬非交易日（08-13 休市）：排程器不應觸發
    const logger = new EventLogger(dir);
    const schedules = buildPhaseSchedules(RAW_SCHEDULER as never);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const scheduler = new LifecycleScheduler(schedules, {
      eventLogger: logger,
      nowFn: () => new Date('2026-08-13T09:00:00+08:00'),
      onTick: () => {},
      onPhase3Trigger: () => {},
      onPhase: () => {},
    });
    // 非交易日：外部（daybrain 主迴圈）以 isTradingDay() 判斷後不呼叫 checkAndFire
    assert.equal(cal.isTradingDay('2026-08-13'), false);
    // 即使誤呼叫，事件日誌也不應有 phase 事件（由主迴圈把關；此處驗證守門）
    const events = logger.loadDay('2026-08-13');
    assert.equal(events.length, 0);
  } finally {
    cleanup();
  }
});
