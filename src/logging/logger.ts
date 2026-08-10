import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isoInTaipei } from '../utils/time.js';

/**
 * 結構化 JSON 日誌（事件型，支援回放）
 * - 每行一個 JSON 物件，含 ts / type 欄位
 * - LOG_DIR 可由環境變數設定
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  ts: string; // ISO 8601（Asia/Taipei）
  type: string; // 事件型別，如 'boot' | 'phase0_start' | 'signal'
  level: LogLevel;
  [key: string]: unknown;
}

export class JsonLogger {
  readonly dir: string;
  private readonly stream: string;
  private readonly consoleEnabled: boolean;

  constructor(logDir: string, consoleEnabled = true) {
    this.dir = resolve(logDir);
    this.consoleEnabled = consoleEnabled;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    // 每日一個檔案，檔名含 Taipei 日期
    this.stream = join(this.dir, `daybrain-${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  log(type: string, level: LogLevel, fields: Record<string, unknown> = {}): void {
    const event: LogEvent = { ts: isoInTaipei(), type, level, ...fields };
    const line = JSON.stringify(event);
    appendFileSync(this.stream, line + '\n', 'utf-8');
    if (this.consoleEnabled) {
      const prefix = `[${event.ts}] ${level.toUpperCase()} ${type}`;
      if (level === 'error') console.error(prefix, fields);
      else console.log(prefix, fields);
    }
  }

  debug(type: string, fields?: Record<string, unknown>): void {
    this.log(type, 'debug', fields);
  }
  info(type: string, fields?: Record<string, unknown>): void {
    this.log(type, 'info', fields);
  }
  warn(type: string, fields?: Record<string, unknown>): void {
    this.log(type, 'warn', fields);
  }
  error(type: string, fields?: Record<string, unknown>): void {
    this.log(type, 'error', fields);
  }

  /** 目前日誌檔完整路徑（供回放讀取） */
  currentFile(): string {
    return this.stream;
  }
}
