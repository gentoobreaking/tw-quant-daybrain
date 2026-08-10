// 時區工具（§17 技術選型）
// 統一使用 Asia/Taipei，禁止使用本機時區隱式轉換。

export const TIME_ZONE = 'Asia/Taipei';

/** 回傳 Taipei 時區的目前日期（YYYY-MM-DD），以 en-CA 產生 ISO 形式日期 */
export function todayInTaipei(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 回傳 Taipei 時區的目前時間（HH:MM:SS） */
export function nowTimeInTaipei(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);
}

/** 回傳 Taipei 時區的完整 ISO 時間戳（含時區偏移 +08:00） */
export function isoInTaipei(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+08:00`;
}

/** 將 Date 轉為 Taipei 時區的「HH:MM」字串（供與 NO_ENTRY_AFTER / FORCE_CLOSE_AT 比較） */
export function hhmmInTaipei(now: Date = new Date()): string {
  return nowTimeInTaipei(now).slice(0, 5);
}

/** 判斷 Taipei 目前時間是否 >= 指定 HH:MM（字串比較可行，因格式固定 HH:MM） */
export function isAtOrAfter(hhmm: string, now: Date = new Date()): boolean {
  return hhmmInTaipei(now) >= hhmm;
}
