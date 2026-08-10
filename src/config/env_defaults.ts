// 環境變數（§17.1 為唯一真值來源）
// 所有變數在此定義預設值，並由 src/config/env.ts 統一載入。
export const ENV_DEFAULTS: Record<string, string> = {
  // 時區：固定 Asia/Taipei，禁止隱式轉換
  TIME_ZONE: 'Asia/Taipei',

  // MCP 連線
  MCP_SERVER_BIN: '/usr/local/bin/tw-quant-mcp',
  MCP_TRANSPORT: 'stdio',

  // 資料新鮮度守門（§3）
  DATA_STALENESS_MAX_SEC: '30',

  // 訊號評分門檻（§8.3 / §5.3）
  SCORE_THRESHOLD: '80',
  NEUTRAL_SCORE_THRESHOLD: '85',
  BIAS_LOCK_SCORE: '50',

  // 風控（§11）
  RISK_PER_TRADE: '0.005',
  MAX_POSITIONS: '2',
  MAX_DAILY_LOSS_PCT: '3.0',
  TOTAL_MARGIN_POOL_NTD: '3000000',
  MAX_LEVERAGE: '2.0',
  SECTOR_LIMIT_PCT: '0.40',

  // 策略觸發（§6/§7）
  VOLUME_SURGE_THRESHOLD: '2.5',

  // 時間限制（§11.5）
  NO_ENTRY_AFTER: '13:00',
  FORCE_CLOSE_AT: '13:20',

  // 紙上交單（§18.3 Human-in-the-loop / headless）
  HEADLESS: 'false',
  PAPER_CONFIRM: 'false',

  // 路徑
  LOG_DIR: './logs',
  DATA_DIR: './data/historical_1m',
};

export type EnvKey = keyof typeof ENV_DEFAULTS;
