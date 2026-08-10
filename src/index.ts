import { loadConfig } from './config/index.js';
import { JsonLogger } from './logging/logger.js';
import { EventLogger } from './logging/event_logger.js';
import { runSingleProcess, createContext } from './ops/single_process.js';
import { todayInTaipei, hhmmInTaipei, isoInTaipei } from './utils/time.js';

/**
 * 單進程部署入口（T001 最小啟動 → T014 升級）
 * - 載入設定（yaml + 環境變數覆寫）
 * - 初始化結構化 JSON 日誌
 * - 以子程序拉起 tw-quant-mcp（MCP_SERVER_BIN）
 * - 交易日自動執行、非交易日休眠（T005）
 * - SIGINT/SIGTERM → 優雅關閉（system_shutdown 事件）
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const { env } = config;

  const logger = new JsonLogger(env.LOG_DIR);
  const eventLogger = new EventLogger(env.LOG_DIR);

  logger.info('boot', {
    version: '0.1.0',
    timezone: env.TIME_ZONE,
    date: todayInTaipei(),
    now: hhmmInTaipei(),
    log_dir: env.LOG_DIR,
    data_dir: env.DATA_DIR,
    mcp_server_bin: env.MCP_SERVER_BIN,
    mcp_transport: env.MCP_TRANSPORT,
    headless: env.HEADLESS,
    paper_confirm: env.PAPER_CONFIRM,
    force_close_at: env.FORCE_CLOSE_AT,
    score_threshold: env.SCORE_THRESHOLD,
    neutral_score_threshold: env.NEUTRAL_SCORE_THRESHOLD,
    bias_lock_score: env.BIAS_LOCK_SCORE,
    risk_per_trade: env.RISK_PER_TRADE,
    max_positions: env.MAX_POSITIONS,
    max_daily_loss_pct: env.MAX_DAILY_LOSS_PCT,
    total_margin_pool_ntd: env.TOTAL_MARGIN_POOL_NTD,
    max_leverage: env.MAX_LEVERAGE,
    sector_limit_pct: env.SECTOR_LIMIT_PCT,
    volume_surge_threshold: env.VOLUME_SURGE_THRESHOLD,
    no_entry_after: env.NO_ENTRY_AFTER,
    scoring_yaml_keys: Object.keys(config.scoring),
    scheduler_yaml_keys: Object.keys(config.scheduler),
  });

  const ctx = createContext();
  const onSignal = () => {
    logger.info('signal_received', { at: isoInTaipei(new Date()) });
    ctx.cancel();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const result = await runSingleProcess(
      {
        env,
        schedulerRaw: config.scheduler,
        scoringRaw: config.scoring,
        logger,
        eventLogger,
      },
      ctx,
    );
    logger.info('exit', {
      trading_day: result.tradingDay,
      shutdown_reason: result.shutdownReason,
      fired_phases: result.firedPhases.length,
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
