// T014 單進程部署 測試
// 驗收：非交易日休眠、交易日執行、優雅關閉（system_shutdown）、Phase 觸發、強制平倉提醒

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLogger } from '../logging/event_logger.js';
import { JsonLogger } from '../logging/logger.js';
import {
  runSingleProcess,
  createContext,
  type SingleProcessOptions,
} from './single_process.js';
import type { EnvConfig } from '../config/env.js';

const BASE_ENV: EnvConfig = {
  TIME_ZONE: 'Asia/Taipei',
  MCP_SERVER_BIN: '/usr/local/bin/tw-quant-mcp',
  MCP_TRANSPORT: 'stdio',
  HEADLESS: true,
  PAPER_CONFIRM: false,
  DATA_STALENESS_MAX_SEC: 30,
  SCORE_THRESHOLD: 80,
  NEUTRAL_SCORE_THRESHOLD: 85,
  BIAS_LOCK_SCORE: 50,
  RISK_PER_TRADE: 0.005,
  MAX_POSITIONS: 2,
  MAX_DAILY_LOSS_PCT: 3.0,
  TOTAL_MARGIN_POOL_NTD: 3_000_000,
  MAX_LEVERAGE: 2.0,
  SECTOR_LIMIT_PCT: 0.4,
  VOLUME_SURGE_THRESHOLD: 2.5,
  NO_ENTRY_AFTER: '13:00',
  FORCE_CLOSE_AT: '13:20',
  LOG_DIR: '.',
  DATA_DIR: '.',
};

const SCHEDULER_RAW = {
  timezone: 'Asia/Taipei',
  phases: [
    { name: 'phase0_ready', time: '08:15' },
    { name: 'phase1_premarket', time: '08:30' },
    { name: 'phase2_intraday', time: '09:00', end: '12:30', tick_sec: 10 },
    { name: 'phase3_close', time: '11:30' },
    { name: 'phase3_close_1320', time: '13:20' },
    { name: 'phase4_postmarket', time: '14:30' },
  ],
  intraday: { tick_sec: 10 },
};

function makeOpts(logDir: string, overrides: Partial<SingleProcessOptions> = {}): SingleProcessOptions {
  return {
    env: { ...BASE_ENV, LOG_DIR: logDir, DATA_DIR: logDir },
    schedulerRaw: SCHEDULER_RAW as never,
    scoringRaw: {} as never,
    logger: new JsonLogger(logDir),
    eventLogger: new EventLogger(logDir),
    loadCalendar: async () => ({
      trading_days: ['2026-08-10', '2026-08-11', '2026-08-12'],
    }),
    createClient: () => ({
      connect: async () => true,
      close: async () => {},
      tools: [],
      state: 'CONNECTED',
      breaker: 'CLOSED',
    }) as never,
    nowFn: () => new Date('2026-08-10T08:10:00+08:00'),
    ...overrides,
  };
}

test('非交易日：休眠回傳 tradingDay=false、不寫 system_shutdown', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 't014-sleep-'));
  const opts = makeOpts(logDir, {
    loadCalendar: async () => ({ trading_days: ['2026-08-11'] }), // 08-10 非交易日
  });
  const result = await runSingleProcess(opts);
  assert.equal(result.tradingDay, false);
  assert.equal(result.shutdownReason, 'non_trading_day');
  const events = new EventLogger(logDir).loadDay('2026-08-10');
  assert.equal(events.some((e) => e.type === 'system_shutdown'), false);
});

test('交易日：排程器啟動、Phase 依時觸發、優雅關閉寫 system_shutdown', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 't014-day-'));
  const fired: string[] = [];
  // 模擬時間推進：clock 起始 08:16（phase0 08:15 已過），首次 checkAndFire 即觸發
  let clock = new Date('2026-08-10T08:16:00+08:00');
  const opts = makeOpts(logDir, {
    nowFn: () => clock,
    onPhase: async (phase) => {
      fired.push(phase);
    },
  });

  // 手動推進時鐘的 context：每次 waitForCancel 回傳後推進
  const ctx = createContext();
  const runPromise = runSingleProcess(opts, ctx);
  // clock 每 30ms +30 秒；等首次 checkAndFire 完成後取消
  const timer = setInterval(() => {
    clock = new Date(clock.getTime() + 30_000);
    if (clock >= new Date('2026-08-10T08:20:00+08:00')) {
      ctx.cancel();
    }
  }, 200);

  const result = await runPromise;
  clearInterval(timer);

  assert.equal(result.tradingDay, true);
  assert.ok(fired.includes('phase0_ready'), `應觸發 phase0（實際 ${fired.join(',')}）`);
  assert.equal(result.shutdownReason, 'user_shutdown');

  const events = new EventLogger(logDir).loadDay('2026-08-10');
  const shutdown = events.filter((e) => e.type === 'system_shutdown');
  assert.equal(shutdown.length, 1);
  assert.equal(shutdown[0].reason, 'user_shutdown');
});

test('優雅關閉：Phase 3 已觸發 → 強制平倉提醒 + 多通道警示 + system_shutdown', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 't014-graceful-'));
  let clock = new Date('2026-08-10T13:20:30+08:00');
  const fired: string[] = [];
  const alerts: Array<{ level: string; channel: string; text: string }> = [];
  const opts = makeOpts(logDir, {
    nowFn: () => clock,
    notify: (m) => alerts.push(m),
    onPhase: async (phase) => {
      fired.push(phase);
      // phase3_1320 觸發後推進到 13:21 觸發取消
      if (phase === 'phase3_close_1320') {
        clock = new Date('2026-08-10T13:21:00+08:00');
      }
    },
  });
  const ctx = createContext();
  const runPromise = runSingleProcess(opts, ctx);
  const timer = setInterval(() => {
    if (clock >= new Date('2026-08-10T13:21:00+08:00')) {
      ctx.cancel();
    }
  }, 30);

  await runPromise;
  clearInterval(timer);

  assert.ok(fired.includes('phase3_close_1320'));
  // 多通道提醒：notify 鉤子收到 force_flat alert
  const alert = alerts.find((a) => a.level === 'alert');
  assert.ok(alert, '應收到強制平倉 alert 提醒');
  assert.equal(alert.channel, 'terminal');
  assert.match(alert.text, /強制平倉/);
  const events = new EventLogger(logDir).loadDay('2026-08-10');
  const shutdown = events.filter((e) => e.type === 'system_shutdown');
  assert.equal(shutdown.length, 1);
});

test('createContext：cancel 後 waitForCancel 立即回傳 true', async () => {
  const ctx = createContext();
  ctx.cancel();
  const done = await ctx.waitForCancel(100);
  assert.equal(done, true);
});

test('createContext：timeout 到期回傳 false', async () => {
  const ctx = createContext();
  const done = await ctx.waitForCancel(50);
  assert.equal(done, false);
});
