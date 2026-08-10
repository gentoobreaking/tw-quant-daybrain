// 事件型別定義（T004，§14.4 events / §1 原則 5「所有決策可回放」）
// 事件為「決策可回放」之唯一資料來源，不得由 LLM 產生（§16）。

/** 事件型別 Enum（§14.4 events 之全部 + v2.0 新增） */
export const EVENT_TYPES = [
  'signal_issued',
  'signal_expired',
  'signal_triggered',
  'position_opened',
  'position_closed',
  'freshness_gate_pass',
  'freshness_gate_fail',
  'position_state_change',
  'failed_breakout',
  'daily_lockout',
  'bias_locked', // v2.0（§5 鎖定結果）
  'briefing_generated', // v2.0（§9）
  'priority_ranked', // v2.0（§10 派單決策）
  'phase_start',
  'phase_end',
  'system_shutdown',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** 事件關聯欄位（signal_id / position_id 可串接） */
export interface EventLinks {
  /** 訊號 ID（signal_issued → signal_triggered → position_opened） */
  signal_id?: string;
  /** 持倉 ID（position_opened → position_closed） */
  position_id?: string;
  /** 標的代碼 */
  symbol?: string;
}

/**
 * 交易日誌事件（append-only，JSON Lines）。
 * 寫入前以 zod 驗證欄位與型別。
 */
export interface DayBrainEvent extends EventLinks {
  /** 事件時間（ISO 8601，Asia/Taipei） */
  ts: string;
  /** 事件型別 */
  type: EventType;
  /** 事件版本（向後相容，欄位新增時遞增） */
  version: number;
  /** 事件序號（單檔內遞增，供回放排序） */
  seq: number;
  /** 自由欄位（各事件專屬資料，如 reason、score、cause） */
  [key: string]: unknown;
}

/** 事件 Schema 驗證（zod）：寫入前驗證欄位與型別，失敗即抛錯 */
export interface EventSchema {
  type: EventType;
  /** 必填欄位 */
  required?: string[];
  /** 型別檢查（欄位名 → 檢查函式） */
  fieldChecks?: Record<string, (v: unknown) => boolean>;
}

/** 事件 Schema 註冊表（§14.4 events 之全部） */
export const EVENT_SCHEMAS: Record<EventType, EventSchema> = {
  signal_issued: {
    type: 'signal_issued',
    required: ['signal_id', 'symbol', 'score'],
    fieldChecks: { score: (v) => typeof v === 'number' },
  },
  signal_expired: {
    type: 'signal_expired',
    required: ['signal_id'],
  },
  signal_triggered: {
    type: 'signal_triggered',
    required: ['signal_id'],
  },
  position_opened: {
    type: 'position_opened',
    required: ['position_id', 'symbol'],
  },
  position_closed: {
    type: 'position_closed',
    required: ['position_id', 'reason'],
  },
  freshness_gate_pass: {
    type: 'freshness_gate_pass',
    fieldChecks: { lagSec: (v) => typeof v === 'number' },
  },
  freshness_gate_fail: {
    type: 'freshness_gate_fail',
    required: ['cause'],
    fieldChecks: { lagSec: (v) => typeof v === 'number' },
  },
  position_state_change: {
    type: 'position_state_change',
    required: ['position_id', 'from', 'to'],
  },
  failed_breakout: {
    type: 'failed_breakout',
    required: ['signal_id', 'symbol'],
  },
  daily_lockout: {
    type: 'daily_lockout',
    required: ['reason'],
  },
  bias_locked: {
    type: 'bias_locked',
    required: ['bias', 'score'],
  },
  briefing_generated: {
    type: 'briefing_generated',
    required: ['briefing_id'],
  },
  priority_ranked: {
    type: 'priority_ranked',
    required: ['candidates'],
  },
  phase_start: {
    type: 'phase_start',
    required: ['phase'],
  },
  phase_end: {
    type: 'phase_end',
    required: ['phase'],
  },
  system_shutdown: {
    type: 'system_shutdown',
    required: ['reason'],
  },
};

/** 事件 Schema 驗證錯誤（結構化） */
export class EventValidationError extends Error {
  readonly eventType: string;
  readonly issues: string[];

  constructor(eventType: string, issues: string[]) {
    super(`事件驗證失敗 [${eventType}]: ${issues.join('; ')}`);
    this.name = 'EventValidationError';
    this.eventType = eventType;
    this.issues = issues;
  }
}

/** 驗證事件欄位（Schema 註冊表）；失敗丢 EventValidationError */
export function validateEvent(
  type: EventType,
  fields: Record<string, unknown>,
): void {
  const schema = EVENT_SCHEMAS[type];
  const issues: string[] = [];

  for (const req of schema.required ?? []) {
    if (fields[req] === undefined || fields[req] === null || fields[req] === '') {
      issues.push(`缺少必填欄位 ${req}`);
    }
  }
  for (const [field, check] of Object.entries(schema.fieldChecks ?? {})) {
    if (fields[field] !== undefined && !check(fields[field])) {
      issues.push(`欄位 ${field} 型別錯誤`);
    }
  }
  if (issues.length > 0) {
    throw new EventValidationError(type, issues);
  }
}
