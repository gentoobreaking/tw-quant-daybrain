import { loadConfig } from './config/index.js';
import { JsonLogger } from './logging/logger.js';
import { todayInTaipei, hhmmInTaipei } from './utils/time.js';

/**
 * 最小可啟動進程（T001）
 * - 載入設定（yaml + 環境變數覆寫）
 * - 初始化結構化 JSON 日誌
 * - 不連 MCP（T002 實作）
 */
export function main(): void {
  const config = loadConfig();
  const { env } = config;

  const logger = new JsonLogger(env.LOG_DIR);

  logger.info('boot', {
    version: '0.1.0',
    timezone: env.TIME_ZONE,
    date: todayInTaipei(),
    now: hhmmInTaipei(),
    log_dir: env.LOG_DIR,
    data_dir: env.DATA_DIR,
    mcp_server_bin: env.MCP_SERVER_BIN,
    mcp_transport: env.MCP_TRANSPORT,
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
    force_close_at: env.FORCE_CLOSE_AT,
    scoring_yaml_keys: Object.keys(config.scoring),
    scheduler_yaml_keys: Object.keys(config.scheduler),
  });

  logger.info('shutdown', { reason: 'boot_check_complete' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
