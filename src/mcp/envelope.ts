// MCP Envelope 型別（§2.2 工具契約）
// 所有 tw-quant-mcp v1.3 工具回傳皆為 Envelope：
//   { data, _lineage, _chart_meta }
// _lineage 為 T003 Freshness Gate 之輸入，解析層不得丟棄。

import type { z } from 'zod';

/** `_lineage.source` 僅允許官方來源（附錄 A） */
export const ALLOWED_LINEAGE_SOURCES = [
  'TWSE',
  'TPEx',
  'MOPS',
  'TAIFEX',
  'MIS',
] as const;
export type LineageSource = (typeof ALLOWED_LINEAGE_SOURCES)[number];

/** `_lineage.freshness` 可能值 */
export type FreshnessKind =
  | 'REALTIME_INTRADAY'
  | 'POST_MARKET_TODAY'
  | 'HISTORICAL';

/** `_lineage` 結構（T003 守門之輸入） */
export interface Lineage {
  /** 資料來源：僅允許官方來源 */
  source: LineageSource | string;
  /** 資料新鮮度類型 */
  freshness: FreshnessKind | string;
  /** 資料抓取時間（ISO 8601） */
  fetched_at: string;
  /** 是否為快取資料 */
  is_cached?: boolean;
  /** 取樣週期（秒） */
  sampling_sec?: number;
  /** 快取 TTL（秒） */
  cache_ttl?: number;
  /** 資料日期（HISTORICAL 用，覆蓋查詢範圍） */
  data_date?: string;
  /** 其他欄位（保留，向前相容） */
  [key: string]: unknown;
}

/** `_chart_meta`（可選，K 線等圖表資料之 metadata） */
export interface ChartMeta {
  chart_type?: string;
  timeframe?: string;
  [key: string]: unknown;
}

/** MCP 工具回傳 Envelope */
export interface Envelope<TData = unknown> {
  data: TData;
  _lineage: Lineage;
  _chart_meta?: ChartMeta;
}

/** 解析失敗時丟出之結構化錯誤 */
export class McpEnvelopeError extends Error {
  readonly tool: string;
  readonly code: 'INVALID_ENVELOPE' | 'MISSING_LINEAGE' | 'MISSING_DATA';
  readonly raw?: unknown;

  constructor(
    tool: string,
    code: McpEnvelopeError['code'],
    message: string,
    raw?: unknown,
  ) {
    super(`[${tool}] ${code}: ${message}`);
    this.name = 'McpEnvelopeError';
    this.tool = tool;
    this.code = code;
    this.raw = raw;
  }
}

/** 驗證並解析 Envelope；失敗丟 McpEnvelopeError（結構化） */
export function parseEnvelope<TData = unknown>(
  tool: string,
  raw: unknown,
): Envelope<TData> {
  if (typeof raw !== 'object' || raw === null) {
    throw new McpEnvelopeError(tool, 'INVALID_ENVELOPE', '回傳非物件', raw);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj._lineage !== 'object' || obj._lineage === null) {
    throw new McpEnvelopeError(tool, 'MISSING_LINEAGE', '缺少 _lineage', raw);
  }
  if (!('data' in obj)) {
    throw new McpEnvelopeError(tool, 'MISSING_DATA', '缺少 data 欄位', raw);
  }
  const envelope: Envelope<TData> = {
    data: obj.data as TData,
    _lineage: obj._lineage as unknown as Lineage,
  };
  if (obj._chart_meta !== undefined) {
    envelope._chart_meta = obj._chart_meta as ChartMeta;
  }
  return envelope;
}

/** zod 型別產生 helper（供型別定義使用，避免 unused import） */
export type ZodType<T> = z.ZodType<T>;
