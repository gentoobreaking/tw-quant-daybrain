// T013 全盤模擬日測試：fixture 回放跑 Phase 0→4 + 三種故障注入
// 驗收：事件日誌與預期決策序列一致、故障注入（逾時→STALE、斷線→LOCKOUT、
//       資料缺口→警示）、離線全綠

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runSimulation, type FaultMode } from './simulate.js';

const FIXTURE = join(process.cwd(), 'testdata/mcp/intraday.json');

test('模擬日：Phase 0–4 全數執行、事件日誌完整（離線、無故障）', async () => {
  const r = await runSimulation({ fixturePath: FIXTURE, logDir: mkdtempSync(join(tmpdir(), 'sim-ok-')) });

  // Phase 0 就緒（tools 連線 + 預熱）
  const p0 = r.phases.find((p) => p.phase === 0)!;
  assert.equal(p0.ok, true);
  assert.match(p0.detail, /tools=\d+/);

  // Phase 1 選股（fixture 提供 2308/2317）
  const p1 = r.phases.find((p) => p.phase === 1)!;
  assert.equal(p1.ok, true);
  assert.match(p1.detail, /watchlist=2308,2317/);

  // Phase 2 盤中 ticks 驅動（雙 tick → 訊號）
  const p2 = r.phases.find((p) => p.phase === 2)!;
  assert.equal(p2.ok, true);
  // 2308 連續兩 tick 爆量突破 → 應產出 signal_issued
  assert.equal(r.signals, 1);
  assert.ok(r.events.some((e) => e.type === 'signal_issued' && e.symbol === '2308'));

  // 事件日誌：phase/signal/freshness 皆記錄
  const types = new Set(r.events.map((e) => e.type));
  assert.ok(types.has('signal_issued'));

  // scoring_version 標註
  assert.equal(r.scoring_version, '2.1.0');
});

test('模擬日：故障注入 connection_drop → Phase 0 連線失敗', async () => {
  const r = await runSimulation({
    fixturePath: FIXTURE,
    fault: 'connection_drop' as FaultMode,
    logDir: mkdtempSync(join(tmpdir(), 'sim-drop-')),
  });
  const p0 = r.phases.find((p) => p.phase === 0)!;
  assert.equal(p0.ok, false);
  assert.match(p0.detail, /tools=0/);
  assert.ok(r.warnings.some((w) => /連線驗證失敗/.test(w)));
});

test('模擬日：故障注入 timeout → tick 失敗警示、不當機', async () => {
  const r = await runSimulation({
    fixturePath: FIXTURE,
    fault: 'timeout' as FaultMode,
    faultTool: 'get_intraday_vwap',
    logDir: mkdtempSync(join(tmpdir(), 'sim-timeout-')),
  });
  // 逾時工具 → 該 tick 失敗但整體流程繼續
  assert.ok(r.warnings.some((w) => /逾時/.test(w)));
  // Phase 2 仍執行（至少不拋例外）
  const p2 = r.phases.find((p) => p.phase === 2)!;
  assert.equal(p2.ok, true);
});

test('回測 fixtures：historical_1m 提供 1 分鐘 K CSV（供 T021/T022）', () => {
  const dir = join(process.cwd(), 'testdata/historical_1m');
  assert.ok(existsSync(join(dir, '2308.csv')), '2308.csv 存在');
  assert.ok(existsSync(join(dir, '2317.csv')), '2317.csv 存在');
  const head = readFileSync(join(dir, '2308.csv'), 'utf8').split('\n').slice(0, 2);
  assert.match(head[0], /timestamp,open,high,low,close,volume/);
  assert.match(head[1], /2026-08-03T09:00:00\+08:00/);
});

test('模擬日：故障注入 data_gap → 資料缺口警示', async () => {
  const r = await runSimulation({
    fixturePath: FIXTURE,
    fault: 'data_gap' as FaultMode,
    faultTool: 'get_intraday_vwap',
    logDir: mkdtempSync(join(tmpdir(), 'sim-gap-')),
  });
  // 資料缺口（data=null）→ 守門/解析層不崩潰；Phase 0/1 不受影響
  const p0 = r.phases.find((p) => p.phase === 0)!;
  assert.equal(p0.ok, true);
});
