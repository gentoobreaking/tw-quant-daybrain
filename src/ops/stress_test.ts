// 全交易日壓測工具（T015，§19 Roadmap Phase 4 收尾）
// - 以 10s tick 連續 09:00–13:30 運行模擬盤（T013 harness 驅動）
// - 驗證：無 tick 遺漏（expected vs actual）、事件日誌完整、記憶體穩定（heap 無持續增長）
// - 輸出 JSON 報告（供 CI 比對）+ 人類可讀摘要
// - 壓測不呼叫 live MCP：以 testdata/mcp/intraday.json fixtures 回放（reuse 模式）

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runSimulation, type SimulateOptions } from '../simulate/simulate.js';

export interface StressReport {
  date: string;
  start_at?: string;
  end_at?: string;
  duration_ms: number;
  expected_ticks: number;
  executed_ticks: number;
  missed_ticks: number;
  events_total: number;
  events_by_type: Record<string, number>;
  heap: {
    start_mb: number;
    end_mb: number;
    growth_mb: number;
    /** 最後 10 個採樣 vs 前 10 個採樣之差（正值 = 持續增長） */
    tail_growth_mb: number;
  };
  ok: boolean;
  warnings: string[];
}

/**
 * 全交易日壓測：09:00–13:30 以 10s tick 驅動模擬盤。
 * @param fixturePath testdata/mcp/intraday.json（或自訂 fixture）
 * @param opts 覆寫模擬選項
 */
export async function runStressTest(
  fixturePath: string,
  opts: Partial<SimulateOptions> = {},
): Promise<StressReport> {
  const logDir = opts.logDir ?? mkdtempSync(join(tmpdir(), 't015-stress-'));

  const start = performance.now();
  const heapSamples: number[] = [];
  const heapTimer = setInterval(() => {
    heapSamples.push(process.memoryUsage().heapUsed / 1024 / 1024);
  }, 50);

  const result = await runSimulation({
    fixturePath,
    logDir,
    stressTicks: true,
    reuseFixtures: true,
    ...opts,
  });

  clearInterval(heapTimer);
  const durationMs = performance.now() - start;

  // 事件統計
  const eventsByType: Record<string, number> = {};
  for (const e of result.events) {
    const t = (e as { type: string }).type;
    eventsByType[t] = (eventsByType[t] ?? 0) + 1;
  }

  const warnings: string[] = [...result.warnings];
  const expectedTicks = (13.5 - 9) * 3600 / 10 + 1; // 09:00:00–13:30:00 每 10s：1621 個時間點（含兩端）
  const executed = result.ticksExecuted;
  const stressWarnings: string[] = [];
  if (executed !== expectedTicks) {
    stressWarnings.push(`tick 遺漏：expected=${expectedTicks} actual=${executed}`);
  }
  if (eventsByType['phase_end'] === undefined && executed > 0) {
    stressWarnings.push('事件日誌缺 phase_end');
  }

  // 記憶體：最後 10 採樣 vs 前 10 採樣
  const head10 = heapSamples.slice(0, 10);
  const tail10 = heapSamples.slice(-10);
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1);
  const tailGrowthMb = tail10.length && head10.length ? avg(tail10) - avg(head10) : 0;
  const growthMb = heapSamples.length
    ? heapSamples[heapSamples.length - 1] - heapSamples[0]
    : 0;

  // ok 僅判定壓測面向（tick 遺漏/事件/記憶體），fixture 既有 warning（低訊號日等）不計失敗
  const ok = executed === expectedTicks && stressWarnings.length === 0 && tailGrowthMb < 5;

  return {
    date: result.date,
    start_at: result.startAt,
    end_at: result.endAt,
    duration_ms: Math.round(durationMs),
    expected_ticks: expectedTicks,
    executed_ticks: executed,
    missed_ticks: expectedTicks - executed,
    events_total: result.events.length,
    events_by_type: eventsByType,
    heap: {
      start_mb: heapSamples[0] ?? 0,
      end_mb: heapSamples[heapSamples.length - 1] ?? 0,
      growth_mb: growthMb,
      tail_growth_mb: tailGrowthMb,
    },
    ok,
    warnings: [...stressWarnings, ...warnings],
  };
}

export function formatStressReport(r: StressReport): string {
  const lines = [
    `壓測報告（${r.date}）`,
    `  區間：${r.start_at ?? '-'} → ${r.end_at ?? '-'}（${(r.duration_ms / 1000).toFixed(1)}s）`,
    `  tick：${r.executed_ticks}/${r.expected_ticks}（遺漏 ${r.missed_ticks}）`,
    `  事件：${r.events_total} 筆（${Object.entries(r.events_by_type)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}）`,
    `  記憶體：heap ${r.heap.start_mb.toFixed(1)}MB → ${r.heap.end_mb.toFixed(1)}MB` +
      `（成長 ${r.heap.growth_mb.toFixed(2)}MB，尾部 ${r.heap.tail_growth_mb.toFixed(2)}MB）`,
    r.ok ? '  ✅ OK' : `  ⚠️ ${r.warnings.join('; ')}`,
  ];
  return lines.join('\n');
}
