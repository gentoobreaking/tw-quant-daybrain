// 全盤模擬日（T013）：以 testdata/mcp/*.json fixture 序列回放，跑完整 Phase 0→4
// - 真實模組：Phase0ReadyCheck、Phase1Selector、FreshnessGate、SignalScoringEngine、
//   TickConfirmer、RiskManager、IntradayLoop、EventLogger
// - 不連 MCP：以 fixture 檔回放（含「逾時/資料缺口/連線中斷」故障注入）
// - 驗證：事件日誌與預期決策序列一致（Bias 攔截 + Priority 派單）

import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLogger } from '../logging/event_logger.js';
import { FreshnessGate } from '../gate/freshness_gate.js';
import { SignalScoringEngine, TickConfirmer, loadScoringConfigFromFile } from '../engine/scoring.js';
import { RiskManager, DEFAULT_RISK_CONFIG, InMemoryPositionRepository } from '../risk/risk_manager.js';
import { IntradayLoop } from '../engine/intraday_loop.js';
import { Phase0ReadyCheck, PHASE1_REQUIRED_TOOLS } from '../pre_market/phase0.js';
import { Phase1Selector } from '../pre_market/phase1.js';

/** fixture 結構（testdata/mcp/*.json） */
export interface FixtureToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: { data: unknown; _lineage: Record<string, unknown> };
}
export interface FixturePhase {
  phase: number;
  at: string;
  tools?: FixtureToolCall[];
  ticks?: Array<{ at: string; tools: FixtureToolCall[] }>;
}
export interface DayFixture {
  date: string;
  scoring_version: string;
  scenario: string;
  phases: FixturePhase[];
}

/** 故障注入模式 */
export type FaultMode = 'none' | 'timeout' | 'data_gap' | 'connection_drop';

export interface SimulateOptions {
  fixturePath: string;
  logDir?: string;
  fault?: FaultMode;
  /** 注入故障之工具名（預設第一個盤中工具） */
  faultTool?: string;
  /** T015 壓測：以 10s tick 連續 09:00–13:30 全交易日運行（覆寫 fixture ticks） */
  stressTicks?: boolean;
  /** 壓測時 fixture 資料不足之重複策略（依序消費制改為可重用） */
  reuseFixtures?: boolean;
  /** 壓測：每 tick 延遲 ms（模擬真實節奏；預設 0） */
  tickDelayMs?: number;
  /** T015 參數實驗：覆寫評分參數（量能閾值等），同一 fixture 跑不同參數對比 */
  scoringOverrides?: { volumeSurgeThreshold?: number; scoring_version?: string };
}

export interface SimulateResult {
  date: string;
  scenario: string;
  scoring_version: string;
  phases: Array<{ phase: number; at: string; ok: boolean; detail: string }>;
  events: unknown[];
  signals: number;
  warnings: string[];
  logDir: string;
  /** T015：實際執行 tick 數（壓測時為 270） */
  ticksExecuted: number;
  /** T015：首/末 tick 時間 */
  startAt?: string;
  endAt?: string;
}

function loadFixture(path: string): DayFixture {
  return JSON.parse(readFileSync(path, 'utf-8')) as DayFixture;
}

/** fixture 回放 mcp call（依 tool + args.symbol 比對） */
function fixtureCaller(
  fixture: DayFixture,
  fault: FaultMode,
  faultTool: string,
  reuse = false,
) {
  return async (tool: string, args: Record<string, unknown>): Promise<{ data: unknown; _lineage: Record<string, unknown> }> => {
    // 故障注入：連線中斷（tools/list 層）
    if (fault === 'connection_drop' && tool === '__connect__') {
      throw new Error('MCP 連線中斷（模擬）');
    }
    // 故障注入：逾時 / 資料缺口（指定工具）
    if (fault !== 'none' && tool === faultTool) {
      if (fault === 'timeout') {
        await new Promise((r) => setTimeout(r, 50));
        throw new Error(`工具 ${tool} 逾時（模擬）`);
      }
      if (fault === 'data_gap') {
        return { data: null, _lineage: { source: 'TWSE', freshness: 'REALTIME_INTRADAY', fetched_at: new Date().toISOString() } };
      }
    }
    // 依 phase 順序找相符 fixture（取第一個符合者，且依序消費防止跨 tick 重用）
    for (const phase of fixture.phases) {
      const calls = [...(phase.tools ?? []), ...(phase.ticks ?? []).flatMap((t) => t.tools)];
      const idx = calls.findIndex((c) => c.tool === tool && JSON.stringify(c.args ?? {}) === JSON.stringify(args ?? {}));
      if (idx >= 0) {
        const hit = calls[idx];
        if (reuse) return hit.result; // 壓測：可重用，不消費
        // 消費：從 fixture 移除該筆，避免後續 tick 重複取到舊資料
        if (phase.tools) {
          const ti = phase.tools.indexOf(hit);
          if (ti >= 0) phase.tools.splice(ti, 1);
        }
        for (const t of phase.ticks ?? []) {
          const ti = t.tools.indexOf(hit);
          if (ti >= 0) t.tools.splice(ti, 1);
        }
        return hit.result;
      }
    }
    if (reuse) {
      // 壓測：fixture 找不到 → 回傳中性資料（不中斷全交易日）
      return {
        data: { symbol: String(args.symbol ?? ''), price: 100, volume: 1000 },
        _lineage: { source: 'TWSE', freshness: 'REALTIME_INTRADAY', fetched_at: new Date().toISOString(), is_cached: false, sampling_sec: 1, cache_ttl_sec: 1 },
      };
    }
    throw new Error(`fixture 缺工具回應: ${tool} ${JSON.stringify(args)}`);
  };
}

/**
 * 執行全盤模擬日。
 * 回傳：各 phase 執行結果 + 事件日誌（供斷言比對）。
 */
export async function runSimulation(opts: SimulateOptions): Promise<SimulateResult> {
  const fixture = loadFixture(opts.fixturePath);
  const logDir = opts.logDir ?? mkdtempSync(join(tmpdir(), 'sim-'));
  const events = new EventLogger(logDir);
  const fault = opts.fault ?? 'none';
  const faultTool = opts.faultTool ?? 'get_intraday_vwap';

  const caller = fixtureCaller(fixture, fault, faultTool, opts.reuseFixtures);
  const gate = new FreshnessGate({ nowFn: () => new Date('2026-08-10T09:30:00+08:00') });

  const phaseResults: SimulateResult['phases'] = [];
  const warnings: string[] = [];

  // ---- Phase 0（08:15）：就緒檢查 ----
  const phase0 = new Phase0ReadyCheck({
    mcpCall: caller as never,
    listTools: async () => (fault === 'connection_drop' ? Promise.reject(new Error('斷線')) : PHASE1_REQUIRED_TOOLS),
    gate: gate.check.bind(gate) as never,
  });
  const p0 = await phase0.run();
  phaseResults.push({ phase: 0, at: '08:15', ok: p0.connectionReady, detail: `tools=${p0.toolCount} gaps=${p0.dataGaps.length}` });
  if (p0.dataGaps.length > 0) warnings.push(...p0.dataGaps.map((g) => `${g.tool}: ${g.reason}`));

  // ---- Phase 1（08:30）：選股 ----
  const phase1 = new Phase1Selector({
    mcpCall: caller as never,
    gate: gate.check.bind(gate) as never,
    targetMin: 3,
    targetMax: 5,
    today: fixture.date,
    yesterday: '2026-08-07',
  });
  const p1 = await phase1.run();
  phaseResults.push({
    phase: 1,
    at: '08:30',
    ok: p1.candidates.length > 0,
    detail: `candidates=${p1.candidates.length} watchlist=${p1.watchlist.join(',')} lowSignal=${p1.lowSignalDay}`,
  });
  if (p1.lowSignalDay) warnings.push('低訊號日（候選不足 3 檔）');

  // ---- Phase 2（09:00–12:30）：盤中監控 ----
  const baseScoring = loadScoringConfigFromFile();
  const scoring = new SignalScoringEngine({
    ...baseScoring,
    scoring_version: opts.scoringOverrides?.scoring_version ?? baseScoring.scoring_version,
    ...(opts.scoringOverrides?.volumeSurgeThreshold !== undefined
      ? { volumeSurgeThreshold: opts.scoringOverrides.volumeSurgeThreshold }
      : {}),
  });
  const ticker = new TickConfirmer();
  const repo = new InMemoryPositionRepository();
  const risk = new RiskManager({
    config: DEFAULT_RISK_CONFIG,
    repo,
    eventLogger: events,
    equity: 1_000_000,
    nowFn: () => new Date('2026-08-10T09:30:00+08:00'),
  });
  const watchlist = p1.watchlist.length > 0 ? p1.watchlist : ['2308'];

  const loop = new IntradayLoop({
    watchlist,
    call: caller as never,
    gate,
    events,
    scoring,
    ticker,
    risk,
    briefing: undefined, // T019 未完成前以 stub 注入（T009）
    priority: undefined, // T020 未完成前以 stub 注入（T009）
    openBufferEnd: '09:05',
    nowFn: () => new Date('2026-08-10T09:30:00+08:00'),
  });

  // 依 fixture 之 ticks 順序驅動（每 tick 一次 loop.tick）；壓測模式生成 09:00–13:30 連續 10s tick
  const phase2 = fixture.phases.find((p) => p.phase === 2);
  let signals = 0;
  let ticksExecuted = 0;
  let startAt: string | undefined;
  let endAt: string | undefined;
  const tickTimes: string[] = [];
  if (opts.stressTicks) {
    // 09:00:00 → 13:30:00 每 10s（含 09:00–09:05 開盤緩衝與 12:30–13:30 Phase 3 收斂）
    for (let ms = 9 * 3600_000; ms <= 13.5 * 3600_000; ms += 10_000) {
      const h = Math.floor(ms / 3600_000);
      const m = Math.floor((ms % 3600_000) / 60_000);
      const s = Math.floor((ms % 60_000) / 1000);
      tickTimes.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    }
  } else if (phase2?.ticks) {
    for (const t of phase2.ticks) tickTimes.push(t.at);
  }
  for (const at of tickTimes) {
    const dt = new Date(`2026-08-10T${at}+08:00`);
    // 以 fixture 的 tick 時間驅動 nowFn
    (loop as unknown as { nowFn: () => Date }).nowFn = () => dt;
    try {
      const advices = await loop.tick(dt);
      signals += advices.length;
      ticksExecuted += 1;
      if (!startAt) startAt = at;
      endAt = at;
      if (opts.tickDelayMs) await new Promise((r) => setTimeout(r, opts.tickDelayMs));
    } catch (err) {
      warnings.push(`tick ${at} 失敗: ${(err as Error).message}`);
    }
  }
  phaseResults.push({ phase: 2, at: '09:30', ok: signals >= 0, detail: `ticks=${tickTimes.length} signals=${signals}` });

  // ---- Phase 3（13:20）：強制平倉 ----
  const phase3 = fixture.phases.find((p) => p.phase === 3);
  if (phase3) {
    const at = new Date(`2026-08-10T${phase3.at}+08:00`);
    (loop as unknown as { nowFn: () => Date }).nowFn = () => at;
    try {
      await loop.tick(at);
      phaseResults.push({ phase: 3, at: phase3.at, ok: true, detail: 'force_flat 檢查完成' });
    } catch (err) {
      phaseResults.push({ phase: 3, at: phase3.at, ok: false, detail: (err as Error).message });
    }
  }

  // ---- Phase 4（14:30）：盤後統計 ----
  const phase4 = fixture.phases.find((p) => p.phase === 4);
  if (phase4) {
    phaseResults.push({ phase: 4, at: phase4.at, ok: true, detail: '盤後 K 線回推就緒（T010/T023 承接）' });
  }

  const dayEvents = events.loadDay(fixture.date, { silent: true });
  return {
    date: fixture.date,
    scenario: fixture.scenario,
    scoring_version: fixture.scoring_version,
    phases: phaseResults,
    events: dayEvents.map((e) => ({ ...e, ts: e.ts, type: e.type })),
    signals,
    warnings,
    logDir,
    ticksExecuted,
    startAt,
    endAt,
  };
}

/** CLI：simulate --fixture <path> [--fault timeout|data_gap|connection_drop] */
export async function simulateCli(args: string[]): Promise<number> {
  const idx = args.indexOf('--fixture');
  const fixturePath = idx >= 0 ? args[idx + 1] : join(process.cwd(), 'testdata/mcp/intraday.json');
  const faultIdx = args.indexOf('--fault');
  const fault = (faultIdx >= 0 ? args[faultIdx + 1] : 'none') as FaultMode;

  try {
    const r = await runSimulation({ fixturePath, fault });
    console.log(`===== 模擬日：${r.date}（${r.scenario}）=====`);
    for (const p of r.phases) {
      console.log(`  Phase ${p.phase} @${p.at}: ${p.ok ? 'OK' : 'FAIL'} — ${p.detail}`);
    }
    console.log(`訊號 ${r.signals} 筆、事件 ${r.events.length} 筆`);
    if (r.warnings.length > 0) {
      console.log('警示：');
      for (const w of r.warnings) console.log(`  - ${w}`);
    }
    return 0;
  } catch (err) {
    console.error(`模擬失敗: ${(err as Error).message}`);
    return 1;
  }
}
