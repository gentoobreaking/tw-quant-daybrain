// 事件日誌寫入器 + 回放讀取器（T004）
// - append-only：JSON Lines 於 LOG_DIR，每日一個檔案（YYYY-MM-DD.events.jsonl）
// - 寫入前 zod/等效 Schema 驗證，失敗即抛錯
// - 回放：loadDay(date) → Event[] 依 ts 排序
// - 事件關聯：signal_id / position_id 可串接

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  validateEvent,
  EVENT_TYPES,
  type DayBrainEvent,
  type EventType,
} from './event_types.js';
import { isoInTaipei, todayInTaipei } from '../utils/time.js';

/** 事件檔名格式：YYYY-MM-DD.events.jsonl */
export function eventFileName(date: string): string {
  return `${date}.events.jsonl`;
}

/** 回放時跳過之損壞行（附 warning 回呼） */
export interface LoadDayOptions {
  /** 損壞行回呼（預設僅 console.warn） */
  onCorrupt?: (lineNo: number, raw: string, err: unknown) => void;
  /** 是否靜音警告（測試用） */
  silent?: boolean;
}

export class EventLogger {
  readonly logDir: string;

  constructor(logDir: string) {
    this.logDir = resolve(logDir);
    if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
  }

  /** 寫入事件（append-only）；Schema 驗證失敗即抛 EventValidationError */
  write(
    type: EventType,
    fields: Record<string, unknown> = {},
    now: Date = new Date(),
  ): DayBrainEvent {
    if (!EVENT_TYPES.includes(type)) {
      throw new Error(`未知事件型別: ${type}`);
    }
    validateEvent(type, fields);

    const file = this.fileForDate(todayInTaipei(now));
    // 讀取目前 seq（檔案最後一行的 seq + 1）
    const seq = this.nextSeq(file);

    const event: DayBrainEvent = {
      ts: isoInTaipei(now),
      type,
      version: 1,
      seq,
      ...fields,
    };
    appendFileSync(file, JSON.stringify(event) + '\n', 'utf-8');
    return event;
  }

  /** 目前日期之事件檔路徑 */
  fileForDate(date: string): string {
    return join(this.logDir, eventFileName(date));
  }

  /** 計算下一個 seq（掃描檔案最後一行；檔案不存在為 1） */
  private nextSeq(file: string): number {
    if (!existsSync(file)) return 1;
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const last = JSON.parse(lines[i]) as { seq?: number };
        if (typeof last.seq === 'number') return last.seq + 1;
      } catch {
        // 損壞行跳過（seq 依前一有效行）
      }
    }
    return 1;
  }

  /** 回放讀取：loadDay(date) → Event[] 依 ts 排序（再依 seq 穩定排序） */
  loadDay(date: string, options: LoadDayOptions = {}): DayBrainEvent[] {
    const file = this.fileForDate(date);
    if (!existsSync(file)) return [];
    const onCorrupt =
      options.onCorrupt ??
      ((lineNo: number, _raw: string, err: unknown) => {
        if (!options.silent) {
          console.warn(`[EventLogger] 損壞行 #${lineNo} 已跳過: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

    const events: DayBrainEvent[] = [];
    const lines = readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as DayBrainEvent;
        if (typeof parsed.ts !== 'string' || typeof parsed.type !== 'string') {
          throw new Error('缺少 ts/type');
        }
        events.push(parsed);
      } catch (err) {
        onCorrupt(i + 1, line, err);
      }
    }
    // 依 ts 排序；同 ts 依 seq 穩定排序
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.seq ?? 0) - (b.seq ?? 0)));
    return events;
  }

  /**
   * 依 signal_id / position_id 串接事件鏈（決策追溯）。
   * 回傳事件清單中與指定 id 關聯之事件（依 ts 排序）。
   */
  loadChain(date: string, link: { signal_id?: string; position_id?: string }): DayBrainEvent[] {
    const events = this.loadDay(date, { silent: true });
    const { signal_id, position_id } = link;
    return events.filter((e) => {
      if (signal_id && e.signal_id === signal_id) return true;
      if (position_id && e.position_id === position_id) return true;
      return false;
    });
  }
}
