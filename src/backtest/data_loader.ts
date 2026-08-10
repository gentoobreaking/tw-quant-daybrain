// 回測資料載入器（T021，§12.3 歷史 1 分 K DataLoader）
// - 多格式時間解析：ISO `YYYY-MM-DD HH:mm:ss` / 斜線 `YYYY/MM/DD HH:mm` / 民國曆 `115/07/31 09:00`（+1911）→ ISO 8601 +08:00
// - 成交量單位校正：volume_unit LOTS（張，原值）/ SHARES（股，÷1000 轉張）
// - 去重（重複時間戳取首筆）與時間軸順向排序
// - 交易時段濾除：預設僅保留 09:00:00–13:30:00（可關閉）
// - 欄位別名：時間 time/datetime/date；價格 open/開盤價、high/最高價、low/最低價、close/收盤價；量 volume/vol/成交量/qty
// - loadDirectory：依檔名開頭 4–6 位數字提取 symbol（例 2308_20260731.csv → 2308），同名合併去重
// - 壞列跳過附 warning（含列號），不中斷載入
// - 回傳 MinuteBar[]（§12.2 資料契約：symbol/datetime/open/high/low/close/volume）
// - 支援 Shioaji / FinMind / 富邦 / 凱基匯出檔（§12.3）
// - 為 T022 模擬器、T023 Grid Search、T024 WFO 之資料基礎（fixtures: testdata/historical_1m/）

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';
import type { MinuteBar } from './types.js';

export interface DataLoaderOptions {
  /** 成交量單位，預設 LOTS（張） */
  volumeUnit?: 'LOTS' | 'SHARES';
  /** 時間欄位名稱，預設 'datetime'（找不到時依別名順序找） */
  timeColumn?: string;
  /** 是否只保留台股一般交易時間 09:00 ~ 13:30（預設 true） */
  filterRegularMarketHours?: boolean;
  /** 警告輸出函式（預設 console.warn；測試可注入收集） */
  warn?: (message: string) => void;
}

/** 時間欄位別名（§12.3） */
const TIME_COLUMN_ALIASES = ['datetime', 'time', 'date', 'timestamp', '日期'];
const OPEN_COLUMN_ALIASES = ['open', '開盤價'];
const HIGH_COLUMN_ALIASES = ['high', '最高價'];
const LOW_COLUMN_ALIASES = ['low', '最低價'];
const CLOSE_COLUMN_ALIASES = ['close', '收盤價'];
const VOLUME_COLUMN_ALIASES = ['volume', 'vol', '成交量', 'qty'];

/** 民國曆年份轉西元（民國 1 年 = 1912 年；民國 100 年 = 2011 年） */
export function minguoYearToGregorian(minguoYear: number): number {
  return minguoYear + 1911;
}

/**
 * 時間字串收斂為 ISO 8601（帶 +08:00）。
 * 支援：`2026-07-31 09:00:00`、`2026/07/31 09:00`、`115/07/31 09:00`（民國曆）、含 T 之 ISO。
 * 民國曆 2 位數年份（如 `15/07/31`）視為民國 15 年；3 位數（`115/07/31`）為民國 115 年。
 */
export function parseAndNormalizeTimestamp(rawStr: string): string | null {
  let cleanStr = rawStr.trim();
  if (!cleanStr) return null;

  // 民國曆：`115/07/31 09:00` 或 `115-07-31 09:00`（3 位數）或 `15/07/31`（2 位數，民國 15 年）
  const minguoMatch = cleanStr.match(/^(\d{2,3})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(.*))?$/);
  if (minguoMatch) {
    const yearNum = parseInt(minguoMatch[1], 10);
    // 2 位數 → 民國曆（15 → 1926）；3 位數 → 民國曆（115 → 2026）
    const year = yearNum < 100 ? minguoYearToGregorian(yearNum) : minguoYearToGregorian(yearNum);
    const month = minguoMatch[2].padStart(2, '0');
    const day = minguoMatch[3].padStart(2, '0');
    const rest = minguoMatch[4] ?? '00:00:00';
    cleanStr = `${year}-${month}-${day} ${rest}`;
  }

  cleanStr = cleanStr.replace(/\//g, '-');
  const isoStr = cleanStr.includes('T') ? cleanStr : `${cleanStr.replace(' ', 'T')}+08:00`;
  const dateObj = new Date(isoStr);
  if (isNaN(dateObj.getTime())) return null;

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}T${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}:${pad(dateObj.getSeconds())}+08:00`;
}

/** 去重（重複時間戳保留首筆）並時間軸順向排序（§12.3-3） */
export function deduplicateAndSort(bars: MinuteBar[]): MinuteBar[] {
  const seen = new Set<string>();
  const uniqueBars: MinuteBar[] = [];
  for (const bar of bars) {
    if (!seen.has(bar.datetime)) {
      seen.add(bar.datetime);
      uniqueBars.push(bar);
    }
  }
  return uniqueBars.sort((a, b) => (a.datetime > b.datetime ? 1 : -1));
}

export class CsvDataLoader {
  private options: Required<Pick<DataLoaderOptions, 'volumeUnit' | 'timeColumn' | 'filterRegularMarketHours'>> & { warn: (m: string) => void };

  constructor(options?: DataLoaderOptions) {
    this.options = {
      volumeUnit: options?.volumeUnit ?? 'LOTS',
      timeColumn: options?.timeColumn ?? 'datetime',
      filterRegularMarketHours: options?.filterRegularMarketHours ?? true,
      warn: options?.warn ?? ((m) => console.warn(m)),
    };
  }

  public async loadCsvFile(filePath: string, symbol: string): Promise<MinuteBar[]> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`[DataLoader] 找不到 CSV 檔案: ${filePath}`);
    }

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const bars: MinuteBar[] = [];
    let headerMap: Map<string, number> | null = null;
    let lineNumber = 0;

    for await (const line of rl) {
      lineNumber++;
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      const row = trimmedLine.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));

      if (!headerMap) {
        headerMap = new Map();
        row.forEach((colName, index) => {
          headerMap!.set(colName.toLowerCase(), index);
        });
        continue;
      }

      try {
        const datetimeIdx = this.findColumnIndex(headerMap, [this.options.timeColumn, ...TIME_COLUMN_ALIASES]);
        const openIdx = this.findColumnIndex(headerMap, OPEN_COLUMN_ALIASES);
        const highIdx = this.findColumnIndex(headerMap, HIGH_COLUMN_ALIASES);
        const lowIdx = this.findColumnIndex(headerMap, LOW_COLUMN_ALIASES);
        const closeIdx = this.findColumnIndex(headerMap, CLOSE_COLUMN_ALIASES);
        const volumeIdx = this.findColumnIndex(headerMap, VOLUME_COLUMN_ALIASES);

        const rawDatetime = row[datetimeIdx];
        const open = parseFloat(row[openIdx]);
        const high = parseFloat(row[highIdx]);
        const low = parseFloat(row[lowIdx]);
        const close = parseFloat(row[closeIdx]);
        const rawVolume = parseFloat(row[volumeIdx]);

        if (!rawDatetime || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(rawVolume)) {
          this.options.warn(`[DataLoader] 警告: 第 ${lineNumber} 列數值缺漏，已跳過。`);
          continue;
        }

        // 成交量單位轉換（§12.3-2）：SHARES（股）÷1000 → 張
        const volume = this.options.volumeUnit === 'SHARES' ? rawVolume / 1000 : rawVolume;

        const isoDatetime = parseAndNormalizeTimestamp(rawDatetime);
        if (!isoDatetime) {
          this.options.warn(`[DataLoader] 警告: 第 ${lineNumber} 列時間格式無法解析 (${rawDatetime})，已跳過。`);
          continue;
        }

        // 交易時間過濾（§12.3-4）：09:00:00 ~ 13:30:00
        if (this.options.filterRegularMarketHours) {
          const timeOnly = isoDatetime.split('T')[1].substring(0, 8);
          if (timeOnly < '09:00:00' || timeOnly > '13:30:00') continue;
        }

        bars.push({ symbol, datetime: isoDatetime, open, high, low, close, volume });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.options.warn(`[DataLoader] 警告: 第 ${lineNumber} 列解析失敗 (${msg})，已跳過。`);
      }
    }

    return deduplicateAndSort(bars);
  }

  public async loadDirectory(dirPath: string): Promise<Map<string, MinuteBar[]>> {
    const resultMap = new Map<string, MinuteBar[]>();
    const files = await fs.promises.readdir(dirPath);

    for (const file of files) {
      if (!file.endsWith('.csv')) continue;
      // 自動從檔名提取 Symbol（§12.3 範例：`2308_20260731.csv` → 2308）
      const match = file.match(/^(\d{4,6})/);
      if (!match) continue;

      const symbol = match[1];
      const filePath = path.join(dirPath, file);
      const bars = await this.loadCsvFile(filePath, symbol);

      if (resultMap.has(symbol)) {
        const existing = resultMap.get(symbol)!;
        resultMap.set(symbol, deduplicateAndSort([...existing, ...bars]));
      } else {
        resultMap.set(symbol, bars);
      }
    }
    return resultMap;
  }

  private findColumnIndex(headerMap: Map<string, number>, candidates: string[]): number {
    for (const cand of candidates) {
      const idx = headerMap.get(cand.toLowerCase());
      if (idx !== undefined) return idx;
    }
    throw new Error(`找不到匹配欄位: [${candidates.join(', ')}]`);
  }
}
