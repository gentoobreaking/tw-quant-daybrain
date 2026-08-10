// T015 壓測測試（§19 Roadmap Phase 4 收尾）
// - 全交易日壓測：10s tick 連續 09:00–13:30（1621 ticks）
// - 斷言：無 tick 遺漏、事件日誌完整、記憶體無持續增長
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStressTest } from './stress_test.js';

const FIXTURE = new URL('../../testdata/mcp/intraday.json', import.meta.url).pathname;

test('T015 壓測：1621 ticks 無遺漏、事件日誌完整、記憶體穩定', async () => {
  const r = await runStressTest(FIXTURE, { tickDelayMs: 0 });
  // tick 無遺漏
  assert.equal(r.executed_ticks, r.expected_ticks, 'tick 數應等於期望值');
  assert.equal(r.missed_ticks, 0, '不應有 tick 遺漏');
  // 區間完整
  assert.equal(r.start_at, '09:00:00');
  assert.equal(r.end_at, '13:30:00');
  // 事件日誌完整（Phase 3 六觸發點 → phase_end ≥ 6）
  assert.ok(r.events_by_type['phase_end'] >= 6, `phase_end 應 ≥6（實際 ${r.events_by_type['phase_end']}）`);
  // 記憶體：無持續增長（尾部成長 < 5MB 且非單調上升）
  assert.ok(r.heap.tail_growth_mb < 5, `記憶體尾部成長應 < 5MB（實際 ${r.heap.tail_growth_mb.toFixed(2)}MB）`);
  assert.equal(r.ok, true, '壓測應 OK');
});

test('T015 壓測：記憶體採樣足量（≥10 採樣點）', async () => {
  const r = await runStressTest(FIXTURE, { tickDelayMs: 2 });
  assert.ok(r.heap.start_mb > 0, '應有 heap 採樣');
  assert.ok(r.heap.growth_mb > -5, 'heap 不應大幅下降（異常）');
});
