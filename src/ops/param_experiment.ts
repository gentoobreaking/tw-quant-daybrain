// T015 參數實驗工具（§19 Roadmap Phase 4 收尾 / 驗收項 2）
// - 同一 fixture（同一模擬日）對不同評分參數跑 simulate，輸出指標對比表
// - 指標：勝率 / PF / 假突破率 / 訊號數（由 computeJournalEntry 從事件日誌計算）
// - 用法：npm run experiment -- --fixture testdata/mcp/intraday.json
//   --param volume_surge_threshold --values 2.5,3.0,3.5
//   （v2.0 基線 = 量能閾值 3.0；候選 = 2.5）

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimulation } from '../simulate/simulate.js';
import { computeJournalEntry } from '../metrics/journal.js';

export interface ExperimentRow {
  label: string;
  volume_surge_threshold?: number;
  scoring_version: string;
  signals: number;
  win_rate: number;
  profit_factor: number;
  failed_breakout_rate: number;
  trades: number;
}

export interface ExperimentReport {
  fixture: string;
  rows: ExperimentRow[];
  best: ExperimentRow;
  warnings: string[];
}

/** 從 simulate 結果計算指標（事件日誌 → journal） */
export function metricsFromSimulation(
  events: unknown[],
  scoringVersion: string,
  date: string,
): { win_rate: number; profit_factor: number; failed_breakout_rate: number; trades: number } {
  const entry = computeJournalEntry(date, scoringVersion, events as never);
  return {
    win_rate: entry.summary.hit_rate,
    profit_factor: entry.summary.profit_factor,
    failed_breakout_rate: entry.summary.failed_breakout_rate,
    trades: entry.summary.trades_executed,
  };
}

/**
 * 參數實驗：同一 fixture 對多組參數跑 simulate，回傳對比表。
 * @param fixturePath 模擬日 fixture
 * @param paramName 參數名（目前支援 volume_surge_threshold）
 * @param values 參數值清單（第一個為基線）
 */
export async function runParamExperiment(
  fixturePath: string,
  paramName: 'volume_surge_threshold',
  values: number[],
): Promise<ExperimentReport> {
  const rows: ExperimentRow[] = [];
  const warnings: string[] = [];
  const labels: string[] = [];

  if (paramName === 'volume_surge_threshold') {
    // 基線 v2.0 = 3.0；其餘為候選
    labels.push(...values.map((v) => (v === 3 ? 'v2.0 基線' : `候選 ${v}`)));
  }

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const logDir = mkdtempSync(join(tmpdir(), 't015-exp-'));
    const result = await runSimulation({
      fixturePath,
      logDir,
      scoringOverrides: { volumeSurgeThreshold: v, scoring_version: '2.1.0' },
    });
    warnings.push(...result.warnings);
    const m = metricsFromSimulation(result.events, result.scoring_version, result.date);
    rows.push({
      label: labels[i] ?? String(v),
      volume_surge_threshold: v,
      scoring_version: result.scoring_version,
      signals: result.signals,
      ...m,
    });
  }

  // best：PF 最高（平手比勝率）
  const best = [...rows].sort(
    (a, b) =>
      b.profit_factor - a.profit_factor ||
      b.win_rate - a.win_rate ||
      b.signals - a.signals,
  )[0];

  return { fixture: fixturePath, rows, best, warnings };
}

export function formatExperimentReport(r: ExperimentReport): string {
  const lines = [
    `參數實驗（fixture: ${r.fixture.split('/').pop()}）`,
    `  ${'標籤'.padEnd(12)} ${'量能閾值'.padEnd(8)} ${'訊號'.padEnd(5)} ${'勝率%'.padEnd(7)} ${'PF'.padEnd(7)} ${'假突破率%'.padEnd(9)} ${'交易'.padEnd(4)}`,
  ];
  for (const row of r.rows) {
    lines.push(
      `  ${row.label.padEnd(12)} ${String(row.volume_surge_threshold ?? '').padEnd(8)} ` +
        `${String(row.signals).padEnd(5)} ${String(row.win_rate).padEnd(7)} ` +
        `${String(row.profit_factor).padEnd(7)} ${String(row.failed_breakout_rate).padEnd(9)} ` +
        `${String(row.trades).padEnd(4)}`,
    );
  }
  lines.push(`  🏆 最佳：${r.best.label}（PF ${r.best.profit_factor} / 勝率 ${r.best.win_rate}%）`);
  if (r.warnings.length > 0) {
    lines.push(`  ⚠️ warnings: ${[...new Set(r.warnings)].join('; ')}`);
  }
  return lines.join('\n');
}
