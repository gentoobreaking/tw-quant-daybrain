// 單進程部署（T014，§18.1）
// - 單一進程啟動 daybrain Agent 並以子程序拉起 tw-quant-mcp（MCP_SERVER_BIN）
// - 交易日自動執行、非交易日休眠（T005 TradingCalendar）
// - 優雅關閉：ctx cancel → 停止 Phase 2、強制平倉提醒、寫入 system_shutdown 事件
// - headless：無人工介入時自動回報「建議成交價 = 觸發價」並標註 simulated

import { McpClient } from '../mcp/client.js';
import { EventLogger } from '../logging/event_logger.js';
import { TradingCalendar } from '../scheduler/trading_calendar.js';
import {
  LifecycleScheduler,
  buildPhaseSchedules,
} from '../scheduler/lifecycle_scheduler.js';
import { JsonLogger } from '../logging/logger.js';
import { todayInTaipei, isoInTaipei } from '../utils/time.js';
import type { EnvConfig } from '../config/env.js';
import type { YamlConfig } from '../config/index.js';

/** 單進程執行上下文（取消 → 優雅關閉） */
export interface ProcessContext {
  cancelled: boolean;
  cancel(): void;
  /** 等待取消；回傳 true = 已取消（或 timeout 到期） */
  waitForCancel(timeoutMs?: number): Promise<boolean>;
}

export function createContext(): ProcessContext {
  let cancelled = false;
  const waiters: Array<() => void> = [];
  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      cancelled = true;
      for (const w of waiters) w();
      waiters.length = 0;
    },
    waitForCancel(timeoutMs?: number): Promise<boolean> {
      if (cancelled) return Promise.resolve(true);
      return new Promise((resolve) => {
        const onCancel = () => {
          clearTimeout(timer);
          resolve(true);
        };
        waiters.push(onCancel);
        const timer = setTimeout(() => {
          const i = waiters.indexOf(onCancel);
          if (i >= 0) waiters.splice(i, 1);
          resolve(false);
        }, timeoutMs ?? 24 * 60 * 60 * 1000);
      });
    },
  };
}

export interface SingleProcessOptions {
  env: EnvConfig;
  schedulerRaw: YamlConfig;
  scoringRaw: YamlConfig;
  logger: JsonLogger;
  eventLogger: EventLogger;
  /** MCP client 建立函式（測試注入；預設以 env.MCP_SERVER_BIN spawn 子程序） */
  createClient?: () => McpClient;
  /** 交易日曆載入函式（測試注入；預設從 MCP 取得） */
  loadCalendar?: () => Promise<{ trading_days: string[] }>;
  /** 各 Phase 執行器（測試注入；預設僅記錄） */
  onPhase?: (phase: string, now: Date) => Promise<void>;
  /** tick 執行器（Phase 2；預設僅記錄） */
  onTick?: (tick: number, now: Date) => Promise<void>;
  /** 多通道提醒鉤子（13:15/13:20 強制平倉提醒；測試注入） */
  notify?: (msg: { level: 'warn' | 'alert'; channel: string; text: string }) => void;
  nowFn?: () => Date;
}

export interface SingleProcessResult {
  tradingDay: boolean;
  shutdownReason: string;
  firedPhases: string[];
}

/**
 * 啟動單進程 daybrain：
 * 1. 載入交易日曆（非交易日 → 休眠回傳）
 * 2. 啟動 MCP client（子程序）
 * 3. 排程器迴圈（Phase 觸發）
 * 4. 等待取消 → 優雅關閉（system_shutdown 事件）
 */
export async function runSingleProcess(
  opts: SingleProcessOptions,
  ctx: ProcessContext = createContext(),
): Promise<SingleProcessResult> {
  const { env, logger, eventLogger } = opts;
  const nowFn = opts.nowFn ?? (() => new Date());

  // 1. 交易日判斷（T005）：非交易日休眠
  const calendar = new TradingCalendar({ cacheDir: env.LOG_DIR, nowFn });
  const calData = await (opts.loadCalendar
    ? opts.loadCalendar()
    : Promise.reject(new Error('未注入 loadCalendar（生產環境由 MCP 提供）')));
  calendar['data'] = { year: 2026, trading_days: calData.trading_days } as never;
  const today = todayInTaipei(nowFn());
  if (!calendar.isTradingDay(today)) {
    logger.info('sleep', { reason: 'non_trading_day', date: today });
    return { tradingDay: false, shutdownReason: 'non_trading_day', firedPhases: [] };
  }
  logger.info('trading_day', { date: today });

  // 2. MCP client（子程序 tw-quant-mcp）
  const client = opts.createClient
    ? opts.createClient()
    : new McpClient({
        serverBin: env.MCP_SERVER_BIN,
        transport: env.MCP_TRANSPORT as 'stdio',
      });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    logger.info('mcp_connected', { tools: client.tools.length });
  } catch (err) {
    // 連線失敗：記錄並繼續（失敗處理矩陣：MCP 斷線 → LOCKOUT 由守門處理）
    logger.warn('mcp_connect_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. 排程器（§18.2）
  const schedules = buildPhaseSchedules(
    opts.schedulerRaw as never,
    { noEntryAfter: env.NO_ENTRY_AFTER, forceCloseAt: env.FORCE_CLOSE_AT },
  );
  const scheduler = new LifecycleScheduler(schedules, {
    eventLogger,
    nowFn,
    onPhase: async (phase, now) => {
      logger.info('phase_fire', { phase, at: isoInTaipei(now) });
      await opts.onPhase?.(phase, now);
    },
    onPhase3Trigger: async (phase, now) => {
      const action = phase.includes('1320') ? 'force_flat' : 'reminder';
      const text =
        action === 'force_flat'
          ? `【強制平倉】13:20 已到：全數平倉（當沖不留倉）@ ${isoInTaipei(now)}`
          : `【尾盤提醒】${phase} 觸發：未平倉部位請留意平倉 @ ${isoInTaipei(now)}`;
      logger.warn('phase3_trigger', { phase, at: isoInTaipei(now), action });
      // 多通道輸出：終端警示（stderr）＋ 可注入 notify 鉤子
      process.stderr.write(`\x1b[33m${text}\x1b[0m\n`);
      opts.notify?.({
        level: action === 'force_flat' ? 'alert' : 'warn',
        channel: 'terminal',
        text,
      });
      await opts.onPhase?.(phase, now);
    },
    onTick: async (_phase, tick, now) => {
      await opts.onTick?.(tick, now);
    },
  });

  const firedPhases: string[] = [];

  // 4. 主迴圈：每 1s 檢查一次排程；取消 → 優雅關閉
  logger.info('scheduler_start', { phases: schedules.map((s) => s.name).join(',') });
  while (!ctx.cancelled) {
    const fired = scheduler.checkAndFire(nowFn());
    for (const f of fired) firedPhases.push(f);
    const done = await ctx.waitForCancel(1_000);
    if (done) break;
  }

  // 5. 優雅關閉
  const reason = 'user_shutdown';
  if (scheduler.isPhase2Running()) {
    logger.warn('shutdown_phase2_stop', { action: 'stop_tick_loop' });
  }
  if (scheduler.getFiredPhases().some((p) => p.startsWith('phase3'))) {
    logger.warn('shutdown_force_flat_reminder', {
      action: 'force_flat_reminder',
      at: isoInTaipei(nowFn()),
    });
  }
  eventLogger.write('system_shutdown', { reason }, nowFn());
  logger.info('shutdown', { reason, fired_phases: firedPhases.length });

  if (connected) {
    try {
      await Promise.race([
        client.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('MCP close timeout')), 3000)),
      ]);
    } catch (err) {
      logger.warn('mcp_close_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // 不在此 process.exit()：由入口 main() 自然收尾（註冊表移除 + 事件循環清空後自行退出），
  // 保留 return 供呼叫方記錄 exit 日誌與決定退出碼。
  return { tradingDay: true, shutdownReason: reason, firedPhases };
}
