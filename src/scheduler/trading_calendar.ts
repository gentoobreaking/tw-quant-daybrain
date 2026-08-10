// 交易日曆（T005，§4 生命週期 + §18.2 排程）
// 依 get_trading_calendar（T002）取得交易日，快取於本機（LOG_DIR 下 calendar.json）。
// 非交易日休眠：isTradingDay() === false 時不排程任何 Phase。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { todayInTaipei } from '../utils/time.js';

/** get_trading_calendar 之 data 形狀（§2.2 contracts） */
export interface TradingCalendarData {
  year: number;
  trading_days: string[];
  holidays?: Array<{ date: string; name?: string }>;
  [key: string]: unknown;
}

export interface TradingCalendarOptions {
  /** 快取目錄（預設 LOG_DIR） */
  cacheDir?: string;
  /** 快取檔名 */
  cacheFile?: string;
  /** 快取 TTL（ms，預設 6h） */
  cacheTtlMs?: number;
  /** 目前時間函式（測試注入） */
  nowFn?: () => Date;
}

export class TradingCalendar {
  private readonly cacheDir: string;
  private readonly cacheFile: string;
  private readonly cacheTtlMs: number;
  private readonly nowFn: () => Date;
  private data: TradingCalendarData | null = null;

  constructor(options: TradingCalendarOptions = {}) {
    this.cacheDir = resolve(options.cacheDir ?? './logs');
    this.cacheFile = options.cacheFile ?? 'calendar.json';
    this.cacheTtlMs = options.cacheTtlMs ?? 6 * 60 * 60 * 1000;
    this.nowFn = options.nowFn ?? (() => new Date());
  }

  /** 快取檔完整路徑 */
  private cachePath(): string {
    return join(this.cacheDir, this.cacheFile);
  }

  /** 載入快取（存在且未過期 → 使用；否則 null） */
  private loadCache(): TradingCalendarData | null {
    const path = this.cachePath();
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as TradingCalendarData & {
        _cached_at?: number;
      };
      if (typeof raw.year !== 'number' || !Array.isArray(raw.trading_days)) return null;
      // TTL 檢查
      if (typeof raw._cached_at === 'number' && Date.now() - raw._cached_at > this.cacheTtlMs) {
        return null;
      }
      return raw;
    } catch {
      return null; // 快取損壞 → 視為無快取
    }
  }

  /** 寫入快取（含快取時間戳） */
  private saveCache(data: TradingCalendarData): void {
    if (!existsSync(this.cacheDir)) mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(
      this.cachePath(),
      JSON.stringify({ ...data, _cached_at: Date.now() }, null, 2),
      'utf-8',
    );
  }

  /**
   * 載入交易日曆：先試本機快取，快取過期/不存在時呼叫 mcp 重新取得。
   * @param fetchFn 從 mcp 取得交易日曆之函式（T002 整合；測試注入）
   * @param forceRefresh 強制重新取得（跳過快取）
   */
  async load(
    fetchFn: () => Promise<TradingCalendarData>,
    forceRefresh = false,
  ): Promise<TradingCalendarData> {
    if (!forceRefresh) {
      const cached = this.loadCache();
      if (cached) {
        this.data = cached;
        return cached;
      }
    }
    const fresh = await fetchFn();
    if (!fresh || !Array.isArray(fresh.trading_days)) {
      throw new Error('get_trading_calendar 回傳資料格式錯誤（缺 trading_days）');
    }
    this.data = fresh;
    this.saveCache(fresh);
    return fresh;
  }

  /** 今日是否為交易日（需先 load()） */
  isTradingDay(date: string = todayInTaipei(this.nowFn())): boolean {
    if (!this.data) {
      throw new Error('交易日曆尚未載入（請先呼叫 load()）');
    }
    return this.data.trading_days.includes(date);
  }

  /** 下一個交易日（date 之後第一個交易日；不含 date 本身） */
  nextTradingDay(date: string = todayInTaipei(this.nowFn())): string | null {
    if (!this.data) return null;
    const days = [...this.data.trading_days].sort();
    for (const d of days) {
      if (d > date) return d;
    }
    return null;
  }

  /** 上一交易日（date 之前最後一個交易日；不含 date 本身） */
  previousTradingDay(date: string = todayInTaipei(this.nowFn())): string | null {
    if (!this.data) return null;
    const days = [...this.data.trading_days].sort();
    for (let i = days.length - 1; i >= 0; i -= 1) {
      if (days[i] < date) return days[i];
    }
    return null;
  }

  /** 目前快取資料（測試/除錯用） */
  getData(): TradingCalendarData | null {
    return this.data;
  }
}
