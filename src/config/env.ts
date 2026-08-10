import { z } from 'zod';
import { ENV_DEFAULTS } from './env_defaults.js';

/**
 * 設定載入（§17 技術選型）
 * - config/*.yaml 為基礎設定（含註解說明）
 * - 環境變數覆寫（§17.1 為唯一真值來源）
 * - 時區固定 Asia/Taipei
 */

const TimeOnlySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '必須為 HH:MM 格式');

export const EnvConfigSchema = z.object({
  TIME_ZONE: z.string().default(ENV_DEFAULTS.TIME_ZONE),
  MCP_SERVER_BIN: z.string().default(ENV_DEFAULTS.MCP_SERVER_BIN),
  MCP_TRANSPORT: z.enum(['stdio', 'streamable-http']).default('stdio'),
  DATA_STALENESS_MAX_SEC: z.coerce.number().int().positive().default(30),
  SCORE_THRESHOLD: z.coerce.number().min(0).max(100).default(80),
  NEUTRAL_SCORE_THRESHOLD: z.coerce.number().min(0).max(100).default(85),
  BIAS_LOCK_SCORE: z.coerce.number().min(0).max(100).default(50),
  RISK_PER_TRADE: z.coerce.number().positive().default(0.005),
  MAX_POSITIONS: z.coerce.number().int().positive().default(2),
  MAX_DAILY_LOSS_PCT: z.coerce.number().positive().default(3.0),
  TOTAL_MARGIN_POOL_NTD: z.coerce.number().positive().default(3_000_000),
  MAX_LEVERAGE: z.coerce.number().positive().default(2.0),
  SECTOR_LIMIT_PCT: z.coerce.number().min(0).max(1).default(0.4),
  VOLUME_SURGE_THRESHOLD: z.coerce.number().positive().default(2.5),
  NO_ENTRY_AFTER: TimeOnlySchema.default('13:00'),
  FORCE_CLOSE_AT: TimeOnlySchema.default('13:20'),
  LOG_DIR: z.string().default('./logs'),
  DATA_DIR: z.string().default('./data/historical_1m'),
});

export type EnvConfig = z.infer<typeof EnvConfigSchema>;

/** 載入環境變數（§17.1 全部變數，含預設值） */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(ENV_DEFAULTS)) {
    raw[key] = env[key];
  }
  const parsed = EnvConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`環境變數設定無效: ${issues}`);
  }
  return parsed.data;
}

/** 時間字串（HH:MM）轉成分鐘數，供時間比較使用 */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
