// 自動錄製「最新交易日」fixture（T013 延伸）
//
// 用途：把 tw-quant-mcp 對某交易日（預設最新交易日）的實際回應錄成 fixture，
//       讓 `npm run test:simulate -- --fixture testdata/mcp/<date>.json` 跑最新交易日模擬。
//
// 設計要點：
// - 連線 tw-quant-mcp（MCP_SERVER_BIN），實際呼叫盤前/盤中/盤後工具
// - v2.1 回傳 → daybrain fixture 契約標準化：
//   * _lineage.source 對齊守門白名單（TWSE_WEB→TWSE、TWSE_MIS→MIS…）
//   * get_institutional_investors rows → {date, foreign_net, stocks[]}（買超排序、截斷）
//   * get_abnormal_trading array → {stocks:[{symbol, reason}]}
//   * get_major_announcements array → {announcements:[{symbol, title, date}]}（截斷）
//   * get_stock_daily_kline Candle[] → {symbol, period, candles}；freshness → HISTORICAL
//   * 盤中工具（vwap/surge）清 is_cached（避免回放時 cache_ttl 違反守門）
// - fixture 內 args 一律存「simulate 實際呼叫形狀」（Phase 1 三路徑 {}、個股 {symbol}、
//   watchlist {symbols}）；錄製時以真實 args（如 market）呼叫 server
// - 盤中模式（交易日 09:00–13:30）：錄 Phase 2/3 真實 vwap/surge ticks
// - 盤後模式：Phase 2/3 ticks 留空、scan_daytrade_eligibility 以當日注意名單近似合成，
//   並於 _recorded.notes 標註（fixture 僅供引擎回放驗證，非實盤風險掃描）

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import { McpClient } from '../mcp/client.js';
import { loadEnvConfig } from '../config/env.js';
import { todayInTaipei, nowTimeInTaipei } from '../utils/time.js';
import { loadScoringConfigFromFile } from '../engine/scoring.js';
import { buildSelectionPool } from '../pre_market/phase1.js';
import type { Envelope, Lineage } from '../mcp/envelope.js';
import type { DayFixture, FixtureToolCall } from './simulate.js';

// ===== .env 載入（最小實作，無第三方依賴） =====

/** 解析 .env（KEY=VALUE，忽略註解/空行；不覆蓋已存在之 process.env） */
export function loadDotEnv(cwd = process.cwd()): void {
  const p = join(cwd, '.env');
  if (!existsSync(p)) return;
  const raw = readFileSync(p, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// ===== 型別 =====

export interface RecordOptions {
  /** 目標交易日 YYYY-MM-DD（預設：最新交易日） */
  date?: string;
  /** 輸出 fixture 路徑（預設 testdata/mcp/<date>.json） */
  out?: string;
  /** 覆寫候選清單（預設由三路徑選股自動決定；會取代 watchlist） */
  symbols?: string[];
  /** 盤中 tick 數（預設 3；僅盤中模式生效） */
  ticks?: number;
  /** tick 間隔 ms（預設 10_000，尊重 MIS 8s rate limit） */
  tickGapMs?: number;
  /** 重大訊息截斷筆數（預設 200，避免 fixture 過肥） */
  maxAnnouncements?: number;
  /** 覆寫 MCP_SERVER_BIN */
  serverBin?: string;
}

export interface RecordResult {
  fixture: DayFixture & { _recorded: RecordedMeta };
  warnings: string[];
  mode: 'intraday' | 'after_hours';
  candidates: string[];
  watchlist: string[];
  ticksRecorded: number;
  outPath: string;
}

export interface RecordedMeta {
  at: string;
  mode: 'intraday' | 'after_hours';
  source: string;
  notes: string[];
}

// ===== 常數 =====

/** 候選清單上限（對齊 Phase 1 targetMax） */
const TARGET_MAX = 5;
/** 法人買超保留筆數（對齊 INSTITUTIONAL_TOP_N 語意；排序後截斷） */
const INSTITUTIONAL_KEEP = 40;

/** _lineage.source 對齊 daybrain 守門白名單（附錄 A） */
const SOURCE_MAP: Record<string, string> = {
  TWSE_WEB: 'TWSE',
  TWSE_API: 'TWSE',
  TWSE_MIS: 'MIS',
  MIS: 'MIS',
  TPEX: 'TPEx',
  TAIFEX_API: 'TAIFEX',
  TAIFEX_DL: 'TAIFEX',
};

// ===== 標準化 =====

/** lineage.source 對齊白名單（未知來源保留原值，回放時守門會註記） */
export function normalizeSource(source: string): string {
  return SOURCE_MAP[source] ?? source;
}

/** get_institutional_investors：rows → {date, foreign_net, stocks[]}（買超排序、截斷） */
export function normalizeInstitutional(data: unknown): {
  date?: string;
  foreign_net?: number;
  stocks: Array<{ symbol: string; foreign_net?: number; investment_trust_net?: number; dealer_net?: number }>;
} {
  const d = data as { rows?: Array<Record<string, unknown>>; date?: string; total_net?: number } | null;
  const rows = Array.isArray(d?.rows) ? d.rows : [];
  const buy = rows
    .map((r) => ({
      symbol: String(r.code ?? ''),
      foreign_net: num(r.foreign_net),
      investment_trust_net: num(r.investment_net),
      dealer_net: num(r.dealer_net),
    }))
    .filter((r) => r.symbol.length > 0 && (r.foreign_net ?? 0) > 0)
    .sort((a, b) => (b.foreign_net ?? 0) - (a.foreign_net ?? 0))
    .slice(0, INSTITUTIONAL_KEEP);
  return {
    date: d?.date,
    foreign_net: typeof d?.total_net === 'number' ? d.total_net : undefined,
    stocks: buy,
  };
}

/** get_abnormal_trading：array → {stocks:[{symbol, reason}]} */
export function normalizeAbnormal(data: unknown): { stocks: Array<{ symbol: string; reason?: string }> } {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { stocks?: unknown[] } | null)?.stocks)
      ? ((data as { stocks: unknown[] }).stocks)
      : [];
  const stocks = (arr as Array<Record<string, unknown>>)
    .filter((r) => typeof r.code === 'string')
    .map((r) => ({
      symbol: String(r.code),
      reason: typeof r.info === 'string' ? r.info : '成交量異常',
    }))
    // 只保留 4 位數股票代碼（權證 6 位數不在 Symbol Registry，會污染候選）
    .filter((s) => /^\d{4}$/.test(s.symbol));
  return { stocks };
}

/** get_major_announcements：array → {announcements:[{symbol, title, date}]}（截斷） */
export function normalizeAnnouncements(
  data: unknown,
  max = 200,
): { announcements: Array<{ symbol: string; title?: string; date?: string }> } {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { announcements?: unknown[] } | null)?.announcements)
      ? ((data as { announcements: unknown[] }).announcements)
      : [];
  const announcements = (arr as Array<Record<string, unknown>>)
    .filter((r) => typeof r.code === 'string')
    .slice(0, max)
    .map((r) => ({
      symbol: String(r.code),
      title: typeof r.subject === 'string' ? r.subject : undefined,
      date: typeof r.table_date === 'string' ? r.table_date : undefined,
    }));
  return { announcements };
}

/** get_stock_daily_kline：Candle[] → {symbol, period, candles} */
export function normalizeDailyKline(
  data: unknown,
  symbol: string,
): { symbol: string; period: string; candles: unknown[] } {
  const candles = Array.isArray(data)
    ? data
    : Array.isArray((data as { candles?: unknown[] } | null)?.candles)
      ? ((data as { candles: unknown[] }).candles)
      : [];
  return { symbol, period: 'day', candles };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * 標準化單一 Envelope：形狀 + lineage（source 白名單對齊、kline freshness→HISTORICAL、
 * 盤中工具清 is_cached）。
 */
export function normalizeEnvelope(
  tool: string,
  env: Envelope,
  ctx: { symbol?: string; intraday: boolean; fetchedAt?: string },
): Envelope {
  const lineage = { ...env._lineage } as Lineage;
  lineage.source = normalizeSource(String(lineage.source ?? ''));
  if (tool === 'get_stock_daily_kline' && lineage.freshness !== 'HISTORICAL') {
    lineage.freshness = 'HISTORICAL'; // 盤後日K freshness 為 POST_MARKET_TODAY → 對齊守門
  }
  if (ctx.intraday) {
    // 盤中工具：避免回放時 cache_ttl 違反守門（§3.1 快取容許）
    lineage.is_cached = false;
    delete lineage.sampling_sec;
    delete lineage.cache_ttl;
    if (ctx.fetchedAt) lineage.fetched_at = ctx.fetchedAt; // 對齊 tick 時間 → 回放 lag≈0
  }

  let data = env.data;
  switch (tool) {
    case 'get_institutional_investors':
      data = normalizeInstitutional(data);
      break;
    case 'get_abnormal_trading':
      data = normalizeAbnormal(data);
      break;
    case 'get_major_announcements':
      data = normalizeAnnouncements(data);
      break;
    case 'get_stock_daily_kline':
      data = normalizeDailyKline(data, ctx.symbol ?? '');
      break;
    default:
      break;
  }

  return { data, _lineage: lineage, ...(env._chart_meta ? { _chart_meta: env._chart_meta } : {}) };
}

// ===== 交易日解析 =====

/** 從 get_trading_calendar 資料找 ≤ target 的最大交易日 */
export function resolveTradingDay(
  calendarData: Array<{ year: number; trading_days: string[] }>,
  target: string,
): string | null {
  const days = new Set<string>();
  for (const c of calendarData) for (const d of c.trading_days) days.add(d);
  const candidates = [...days].filter((d) => d <= target).sort();
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

// ===== 主流程 =====

/** 判斷是否盤中模式（交易日 09:00–13:30） */
export function isIntradayWindow(now: Date, tradingDay: string): boolean {
  if (todayInTaipei(now) !== tradingDay) return false;
  const t = nowTimeInTaipei(now);
  return t >= '09:00:00' && t <= '13:30:00';
}

/**
 * 錄製最新交易日 fixture。
 * 需要 MCP server 可連線（MCP_SERVER_BIN）；非交易時段僅錄盤後資料。
 */
export async function recordFixture(opts: RecordOptions = {}): Promise<RecordResult> {
  loadDotEnv(); // 載入 .env（MCP_SERVER_BIN 等），不覆蓋既有環境變數
  const warnings: string[] = [];
  const env = loadEnvConfig();
  const serverBin = opts.serverBin ?? env.MCP_SERVER_BIN;

  if (!existsSync(serverBin)) {
    throw new Error(
      `MCP server binary 不存在：${serverBin}（檢查 .env 的 MCP_SERVER_BIN）`,
    );
  }

  // 總 watchdog：防 connect 無限重連/工具呼叫掛住
  const watchdog = setTimeout(() => {
    console.error('錄製逾時（120s），強制結束');
    process.exit(2);
  }, 120_000);
  watchdog.unref?.();

  const client = new McpClient({ serverBin, retryCount: 1 });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`MCP 連線失敗（${serverBin}）：${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    // 暫時性失敗重試（如 Symbol Registry 剛啟動未同步完）：整段錄製最多 2 次
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await recordOnce(client, opts, warnings, serverBin);
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          console.error(
            `⚠ 錄製失敗（第 ${attempt} 次，等待 5s 重試）：${err instanceof Error ? err.message : String(err)}`,
          );
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    await client.close();
    clearTimeout(watchdog);
  }
}

/** 單次錄製主流程（可分離以支援重試） */
async function recordOnce(
  client: McpClient,
  opts: RecordOptions,
  warnings: string[],
  serverBin: string,
): Promise<RecordResult> {
  {
    const now = new Date();
    const today = todayInTaipei(now);

    // 1. 解析目標交易日 + 昨日
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const calMonths: Array<{ year: number; month: number }> = [];
    for (let m = 0; m < 3; m += 1) {
      const y = month - m <= 0 ? year - 1 : year;
      const mo = month - m <= 0 ? month - m + 12 : month - m;
      calMonths.push({ year: y, month: mo });
    }
    const calendarData: Array<{ year: number; trading_days: string[] }> = [];
    for (const cm of calMonths) {
      const calEnv = await client.call<{ year: number; trading_days: string[] }>('get_trading_calendar', {
        year: cm.year,
        month: cm.month,
      });
      calendarData.push(calEnv.data as { year: number; trading_days: string[] });
    }
    const date = opts.date ?? resolveTradingDay(calendarData, today);
    if (!date) {
      throw new Error(`找不到交易日（今天 ${today}）`);
    }
    const dayIndex = new Set<string>();
    for (const c of calendarData) for (const d of c.trading_days) dayIndex.add(d);
    const yesterday = [...dayIndex].filter((d) => d < date).sort().pop() ?? '';

    const mode: 'intraday' | 'after_hours' = isIntradayWindow(now, date) ? 'intraday' : 'after_hours';
    const notes: string[] = [];
    if (mode === 'after_hours') {
      notes.push('盤後錄製：Phase 2/3 盤中 ticks 未錄（get_intraday_vwap/detect_volume_surge 非交易時段不可用）');
      notes.push('盤後錄製：scan_daytrade_eligibility 以當日注意名單近似合成（非實盤掃描）');
    } else {
      notes.push(`盤中錄製：tick 資料為 ${nowTimeInTaipei(now)} 當下快照，非全日回放`);
    }

    // 2. 錄製 Phase 0（simulate 實際 warmup 三路徑；args 用 simulate 呼叫形狀 {}）
    const p0Tools: FixtureToolCall[] = [];
    for (const tool of ['get_institutional_investors', 'get_abnormal_trading', 'get_major_announcements'] as const) {
      const realArgs = tool === 'get_institutional_investors' || tool === 'get_abnormal_trading'
        ? { market: 'tse' }
        : {};
      const env0 = await client.call(tool, realArgs);
      p0Tools.push({
        tool,
        args: {}, // simulate 呼叫形狀
        result: normalizeEnvelope(tool, env0, { intraday: false }),
      });
    }

    // 3. 錄製 Phase 1 三路徑 + 選股
    const instEnv = await client.call('get_institutional_investors', { market: 'tse' });
    const abnEnv = await client.call('get_abnormal_trading', { market: 'tse' });
    const annEnv = await client.call('get_major_announcements', {});
    const inst = normalizeEnvelope('get_institutional_investors', instEnv, { intraday: false });
    const abn = normalizeEnvelope('get_abnormal_trading', abnEnv, { intraday: false });
    const ann = normalizeEnvelope('get_major_announcements', annEnv, { intraday: false });

    const pool = buildSelectionPool(inst.data, abn.data, ann.data);
    const dedupe = [...new Set([...pool.institutional, ...pool.abnormal, ...pool.announcements])];

    const abnormalSymbols = new Set(
      (abn.data as { stocks: Array<{ symbol: string }> }).stocks.map((s) => s.symbol),
    );

    // 合法代碼白名單：注意名單含權證（6 位數），Symbol Registry 只認上市/上櫃股票
    // 注意：get_symbol_list 無參數會混入權證/ETF（11093 檔），須以 market 過濾
    // 另：server 的 Symbol Registry 可能同步失敗（啟動時 30s timeout 僅記錄），
    //     因此以「4 位數股票代碼」為保守白名單，registry 有回應時可再交集
    const symList: string[] = [];
    try {
      for (const market of ['tse', 'otc'] as const) {
        const symEnv = await client.call('get_symbol_list', { market });
        const raw = symEnv.data as Array<{ code: string; market?: string }>;
        if (Array.isArray(raw)) {
          symList.push(...raw.map((s) => String(s.code)));
        }
      }
    } catch {
      // 拿不到清單時退而求其次：只保留 4 位數代碼
    }
    // 白名單 = registry 股票 ∩ 4 位數；registry 空/缺檔時退為純 4 位數
    const validSymbol = (s: string): boolean =>
      /^\d{4}$/.test(s) && (symList.length === 0 || symList.includes(s));
    if (symList.length > 0) {
      const dropped = dedupe.filter((s) => !validSymbol(s));
      if (dropped.length > 0) {
        warnings.push(`過濾 ${dropped.length} 個非股票代碼（權證等）：${dropped.join(', ')}`);
      }
    }

    // Phase 1 的 scan 順序：simulate 對「去重池」依序 scan（每檔都要有回應，
    // 直到湊滿 targetMax=5 個 eligible 候選）→ 錄製時必須覆蓋到第 5 個 eligible 為止
    const scanSymbols = dedupe.filter(validSymbol).slice(0, 30); // 保守上限，避免過度錄製
    if (scanSymbols.length === 0) {
      scanSymbols.push('2308'); // 空池後備
    }
    const p1Tools: FixtureToolCall[] = [
      { tool: 'get_institutional_investors', args: {}, result: inst },
      { tool: 'get_abnormal_trading', args: {}, result: abn },
      { tool: 'get_major_announcements', args: {}, result: ann },
    ];

    // 動態 scan：與 simulate 同邏輯（依序、湊滿 5 檔 eligible 即停）
    const scannedEligible: string[] = [];
    const scannedAll: string[] = [];
    for (const symbol of scanSymbols) {
      if (scannedEligible.length >= TARGET_MAX) break;
      scannedAll.push(symbol);
      if (mode === 'intraday') {
        const scanEnv = await client.call('scan_daytrade_eligibility', { symbol });
        p1Tools.push({
          tool: 'scan_daytrade_eligibility',
          args: { symbol },
          result: normalizeEnvelope('scan_daytrade_eligibility', scanEnv, { intraday: false }),
        });
        const sd = (scanEnv.data ?? {}) as Record<string, unknown>;
        if (sd.eligible === true) scannedEligible.push(symbol);
      } else {
        const isAttention = abnormalSymbols.has(symbol);
        p1Tools.push({
          tool: 'scan_daytrade_eligibility',
          args: { symbol },
          result: {
            data: {
              symbol,
              eligible: !isAttention,
              risk_status: isAttention ? 'ATTENTION' : 'NORMAL',
              is_attention: isAttention,
              is_disposition: false,
            },
            _lineage: {
              source: 'TWSE',
              freshness: 'POST_MARKET_TODAY',
              fetched_at: now.toISOString(),
            },
          },
        });
        if (!isAttention) scannedEligible.push(symbol);
      }
    }
    if (scannedEligible.length < 3) {
      warnings.push(
        `候選僅 ${scannedEligible.length} 檔（低訊號日），模擬會以 watchlist=2308 後備`,
      );
    }

    // 候選 = 前幾個 eligible；watchlist 由 simulate 決定，但 fixture 需提供 K 線
    const candidates = opts.symbols && opts.symbols.length > 0
      ? opts.symbols.filter(validSymbol).slice(0, TARGET_MAX)
      : scannedEligible.slice(0, TARGET_MAX);
    const watchlist = candidates.slice(0, TARGET_MAX);
    if (opts.symbols && opts.symbols.length > 0) {
      // 使用者覆寫候選時，仍要確保 scan 已涵蓋（補錄）
      for (const s of watchlist) {
        if (!scannedAll.includes(s)) {
          p1Tools.push({
            tool: 'scan_daytrade_eligibility',
            args: { symbol: s },
            result: {
              data: { symbol: s, eligible: true, risk_status: 'NORMAL' },
              _lineage: { source: 'TWSE', freshness: 'POST_MARKET_TODAY', fetched_at: now.toISOString() },
            },
          });
        }
      }
    }

    // 候選個股 K 線（Phase 1 buildCandidate + Phase 4 回推都用到）
    const klineSymbols = [...new Set([...scannedAll, ...watchlist])];
    for (const symbol of klineSymbols) {
      const klineEnv = await client.call('get_stock_daily_kline', { symbol });
      p1Tools.push({
        tool: 'get_stock_daily_kline',
        args: { symbol },
        result: normalizeEnvelope('get_stock_daily_kline', klineEnv, { intraday: false, symbol }),
      });
    }

    // watchlist 設定（simulate 呼叫形狀 {symbols}）
    if (watchlist.length > 0) {
      if (mode === 'intraday') {
        const wlEnv = await client.call('set_active_watchlist', { symbols: watchlist });
        p1Tools.push({
          tool: 'set_active_watchlist',
          args: { symbols: watchlist },
          result: normalizeEnvelope('set_active_watchlist', wlEnv, { intraday: false }),
        });
      } else {
        // 盤後：server 拒絕盤中工具 → 合成 accepted（回放僅需設定 watchlist）
        p1Tools.push({
          tool: 'set_active_watchlist',
          args: { symbols: watchlist },
          result: {
            data: { accepted: true, count: watchlist.length },
            _lineage: {
              source: 'TWSE',
              freshness: 'POST_MARKET_TODAY',
              fetched_at: now.toISOString(),
            },
          },
        });
      }
    }

    // 4. Phase 2 ticks（僅盤中模式；每 tick 對 watchlist 呼叫 vwap + surge）
    const ticks = opts.ticks ?? 3;
    const gapMs = opts.tickGapMs ?? 10_000;
    let ticksRecorded = 0;
    const phase2Ticks: Array<{ at: string; tools: FixtureToolCall[] }> = [];
    if (mode === 'intraday' && watchlist.length > 0) {
      for (let i = 0; i < ticks; i += 1) {
        const t = nowTimeInTaipei(new Date());
        const tools: FixtureToolCall[] = [];
        for (const symbol of watchlist) {
          const vwapEnv = await client.call('get_intraday_vwap', { symbol });
          tools.push({
            tool: 'get_intraday_vwap',
            args: { symbol },
            result: normalizeEnvelope('get_intraday_vwap', vwapEnv, {
              intraday: true,
              symbol,
              fetchedAt: new Date().toISOString(),
            }),
          });
          const surgeEnv = await client.call('detect_volume_surge', { symbol });
          tools.push({
            tool: 'detect_volume_surge',
            args: { symbol },
            result: normalizeEnvelope('detect_volume_surge', surgeEnv, {
              intraday: true,
              symbol,
              fetchedAt: new Date().toISOString(),
            }),
          });
        }
        phase2Ticks.push({ at: t, tools });
        ticksRecorded += 1;
        if (i < ticks - 1 && gapMs > 0) {
          await new Promise((r) => setTimeout(r, gapMs));
        }
      }
    } else if (mode === 'intraday') {
      warnings.push('盤中模式但 watchlist 為空，未錄 ticks');
    }

    // 5. Phase 3（盤中模式錄一輪收斂資料；盤後留空）
    const p3Tools: FixtureToolCall[] = [];
    if (mode === 'intraday' && watchlist.length > 0) {
      for (const symbol of watchlist) {
        const vwapEnv = await client.call('get_intraday_vwap', { symbol });
        p3Tools.push({
          tool: 'get_intraday_vwap',
          args: { symbol },
          result: normalizeEnvelope('get_intraday_vwap', vwapEnv, {
            intraday: true,
            symbol,
            fetchedAt: new Date().toISOString(),
          }),
        });
        const surgeEnv = await client.call('detect_volume_surge', { symbol });
        p3Tools.push({
          tool: 'detect_volume_surge',
          args: { symbol },
          result: normalizeEnvelope('detect_volume_surge', surgeEnv, {
            intraday: true,
            symbol,
            fetchedAt: new Date().toISOString(),
          }),
        });
      }
    }

    // 6. Phase 4（每 symbol 當日/最新日 K；盤中錄製時當日 K 未完成，僅供 T010 回推）
    const p4Tools: FixtureToolCall[] = [];
    for (const symbol of watchlist) {
      const klineEnv = await client.call('get_stock_daily_kline', { symbol });
      p4Tools.push({
        tool: 'get_stock_daily_kline',
        args: { symbol },
        result: normalizeEnvelope('get_stock_daily_kline', klineEnv, { intraday: false, symbol }),
      });
    }
    if (mode === 'intraday') {
      notes.push('盤中錄製：Phase 4 當日 K 未收盤，僅為最新交易日快照');
    }

    // 7. 組裝 fixture
    const scoring = loadScoringConfigFromFile();
    const fixture = {
      date,
      scoring_version: scoring.scoring_version,
      scenario: `「${date} 自動錄製（${mode === 'intraday' ? '盤中' : '盤後'}）— ${watchlist.length} 檔候選」`,
      phases: [
        { phase: 0, at: '08:15:00', tools: p0Tools },
        { phase: 1, at: '08:30:00', tools: p1Tools },
        { phase: 2, at: '09:00:00', ticks: phase2Ticks },
        ...(p3Tools.length > 0 ? [{ phase: 3, at: nowTimeInTaipei(new Date()), tools: p3Tools }] : []),
        { phase: 4, at: '14:30:00', tools: p4Tools },
      ],
      _recorded: {
        at: now.toISOString(),
        mode,
        source: `tw-quant-mcp@${serverBin}`,
        notes,
      },
    } as DayFixture & { _recorded: RecordedMeta };

    const outPath = resolve(opts.out ?? join(process.cwd(), 'testdata', 'mcp', `${date}.json`));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n', 'utf-8');

    void yesterday;
    return {
      fixture,
      warnings,
      mode,
      candidates,
      watchlist,
      ticksRecorded,
      outPath,
    };
  }
}

/** CLI：fixture:record [--date YYYY-MM-DD] [--out <path>] [--symbols a,b] [--ticks N] [--tick-gap-ms N] */
export async function recordCli(args: string[]): Promise<number> {
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const opts: RecordOptions = {
    date: opt('--date'),
    out: opt('--out'),
    symbols: opt('--symbols')?.split(',').map((s) => s.trim()).filter(Boolean),
    ticks: opt('--ticks') ? Number(opt('--ticks')) : undefined,
    tickGapMs: opt('--tick-gap-ms') ? Number(opt('--tick-gap-ms')) : undefined,
    serverBin: opt('--server-bin'),
  };

  try {
    const r = await recordFixture(opts);
    console.log('');
    console.log(`📼 已錄製 fixture：${r.outPath}`);
    console.log(`📅 交易日：${r.fixture.date}（${r.mode === 'intraday' ? '盤中模式' : '盤後模式'}）`);
    console.log(`🎯 情境：${r.fixture.scenario}`);
    console.log(`🔍 候選：${r.candidates.join(', ') || '（無）'}`);
    console.log(`📡 watchlist：${r.watchlist.join(', ') || '（空）'}`);
    console.log(`⏱  Phase 2 ticks：${r.ticksRecorded}`);
    if (r.warnings.length > 0) {
      console.log('');
      console.log('⚠️  錄製警示：');
      for (const w of r.warnings) console.log(`      • ${w}`);
    }
    const meta = r.fixture._recorded;
    if (meta.notes.length > 0) {
      console.log('');
      console.log('📝 錄製註記：');
      for (const n of meta.notes) console.log(`      • ${n}`);
    }
    console.log('');
    console.log(`▶ 模擬：npm run test:simulate -- --fixture ${r.outPath}`);
    return 0;
  } catch (err) {
    console.error(`錄製失敗: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
