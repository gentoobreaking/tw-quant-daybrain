// T004 事件日誌與回放 單元測試
// 驗證：事件序列化/反序列化、Schema 驗證、跨日檔案、損壞行跳過、事件關聯鏈

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventLogger,
  eventFileName,
} from './event_logger.js';
import {
  EVENT_TYPES,
  EventValidationError,
  validateEvent,
} from './event_types.js';

function mkLogger(): { dir: string; logger: EventLogger; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'daybrain-events-'));
  const logger = new EventLogger(dir);
  return { dir, logger, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ===== 事件型別 Enum / Schema =====

test('EVENT_TYPES 包含 §14.4 全部事件型別', () => {
  const expected = [
    'signal_issued',
    'signal_expired',
    'signal_triggered',
    'position_opened',
    'position_closed',
    'freshness_gate_pass',
    'freshness_gate_fail',
    'position_state_change',
    'failed_breakout',
    'daily_lockout',
    'bias_locked', // v2.0
    'briefing_generated', // v2.0
    'priority_ranked', // v2.0
    'phase_start',
    'phase_end',
    'system_shutdown',
  ];
  assert.deepEqual([...EVENT_TYPES], expected);
});

test('validateEvent：必填欄位缺失 → EventValidationError', () => {
  assert.throws(
    () => validateEvent('signal_issued', { symbol: '2308' }),
    (err: unknown) =>
      err instanceof EventValidationError &&
      err.eventType === 'signal_issued' &&
      err.issues.some((i) => i.includes('signal_id')),
  );
});

test('validateEvent：型別檢查失敗 → EventValidationError', () => {
  assert.throws(
    () => validateEvent('signal_issued', { signal_id: 'S1', symbol: '2308', score: 'high' }),
    (err: unknown) =>
      err instanceof EventValidationError &&
      err.issues.some((i) => i.includes('score')),
  );
});

test('validateEvent：合法欄位 → 通過', () => {
  assert.doesNotThrow(() =>
    validateEvent('signal_issued', { signal_id: 'S1', symbol: '2308', score: 85 }),
  );
});

// ===== 寫入器（append-only）=====

test('write：每日一個檔案（YYYY-MM-DD.events.jsonl），append-only', () => {
  const { dir, logger, cleanup } = mkLogger();
  try {
    const now = new Date('2026-08-10T09:30:00+08:00');
    logger.write('signal_issued', { signal_id: 'S1', symbol: '2308', score: 85 }, now);
    logger.write('signal_issued', { signal_id: 'S2', symbol: '2330', score: 90 }, now);

    const file = join(dir, eventFileName('2026-08-10'));
    assert.ok(existsSync(file));
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);

    const e1 = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(e1.type, 'signal_issued');
    assert.equal(e1.signal_id, 'S1');
    assert.equal(e1.seq, 1);
    assert.equal(e1.version, 1);
    assert.match(String(e1.ts), /^2026-08-10T09:30:00\+08:00$/);

    const e2 = JSON.parse(lines[1]) as Record<string, unknown>;
    assert.equal(e2.seq, 2); // seq 遞增
  } finally {
    cleanup();
  }
});

test('write：Schema 驗證失敗 → 抛錯且不寫入', () => {
  const { logger, cleanup } = mkLogger();
  try {
    assert.throws(() => logger.write('signal_issued', { symbol: '2308' }));
    const events = logger.loadDay('2026-08-10');
    assert.equal(events.length, 0);
  } finally {
    cleanup();
  }
});

test('write：未知事件型別 → Error', () => {
  const { logger, cleanup } = mkLogger();
  try {
    assert.throws(() => logger.write('not_a_real_event' as never, {}));
  } finally {
    cleanup();
  }
});

test('write：跨日寫入不同檔案', () => {
  const { dir, logger, cleanup } = mkLogger();
  try {
    logger.write('phase_start', { phase: 'phase0' }, new Date('2026-08-10T08:15:00+08:00'));
    logger.write('phase_start', { phase: 'phase0' }, new Date('2026-08-11T08:15:00+08:00'));
    assert.ok(existsSync(join(dir, '2026-08-10.events.jsonl')));
    assert.ok(existsSync(join(dir, '2026-08-11.events.jsonl')));
    assert.equal(logger.loadDay('2026-08-10').length, 1);
    assert.equal(logger.loadDay('2026-08-11').length, 1);
  } finally {
    cleanup();
  }
});

// ===== 回放讀取器 =====

test('loadDay：依 ts 排序（同 ts 依 seq）', () => {
  const { logger, cleanup } = mkLogger();
  try {
    const t1 = new Date('2026-08-10T09:31:00+08:00');
    const t2 = new Date('2026-08-10T09:30:00+08:00');
    const t3 = new Date('2026-08-10T09:30:00+08:00'); // 同 t2
    logger.write('signal_issued', { signal_id: 'S3', symbol: '2308', score: 80 }, t1);
    logger.write('signal_issued', { signal_id: 'S1', symbol: '2308', score: 85 }, t2);
    logger.write('signal_issued', { signal_id: 'S2', symbol: '2308', score: 88 }, t3);

    const events = logger.loadDay('2026-08-10');
    assert.deepEqual(
      events.map((e) => e.signal_id),
      ['S1', 'S2', 'S3'],
    );
  } finally {
    cleanup();
  }
});

test('loadDay：檔案不存在 → 空陣列', () => {
  const { logger, cleanup } = mkLogger();
  try {
    assert.deepEqual(logger.loadDay('2099-01-01'), []);
  } finally {
    cleanup();
  }
});

test('loadDay：損壞行跳過（附 warning），有效行仍回傳', () => {
  const { dir, logger, cleanup } = mkLogger();
  try {
    logger.write('phase_start', { phase: 'phase1' }, new Date('2026-08-10T08:30:00+08:00'));
    const file = join(dir, '2026-08-10.events.jsonl');
    // 附加兩行損壞資料
    writeFileSync(file, 'not-json{{{}\n{"ts":123}\n', { flag: 'a' });

    const warnings: number[] = [];
    const events = logger.loadDay('2026-08-10', {
      onCorrupt: (lineNo) => warnings.push(lineNo),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'phase_start');
    assert.equal(warnings.length, 2, '兩行損壞都應觸發 warning');
  } finally {
    cleanup();
  }
});

// ===== 事件關聯鏈 =====

test('loadChain：signal_id / position_id 串接（signal_issued → position_opened → position_closed）', () => {
  const { logger, cleanup } = mkLogger();
  try {
    const now = new Date('2026-08-10T09:45:00+08:00');
    logger.write('signal_issued', { signal_id: 'SIG-001', symbol: '2308', score: 88 }, now);
    logger.write('signal_triggered', { signal_id: 'SIG-001', symbol: '2308' }, new Date('2026-08-10T09:46:00+08:00'));
    logger.write('position_opened', { position_id: 'P-01', signal_id: 'SIG-001', symbol: '2308' }, new Date('2026-08-10T09:46:30+08:00'));
    logger.write('position_closed', { position_id: 'P-01', reason: 'take_profit', pnl: 12500 }, new Date('2026-08-10T10:02:00+08:00'));

    // 以 signal_id 追溯
    const chain = logger.loadChain('2026-08-10', { signal_id: 'SIG-001' });
    assert.deepEqual(
      chain.map((e) => e.type),
      ['signal_issued', 'signal_triggered', 'position_opened'],
    );

    // 以 position_id 追溯
    const posChain = logger.loadChain('2026-08-10', { position_id: 'P-01' });
    assert.deepEqual(
      posChain.map((e) => e.type),
      ['position_opened', 'position_closed'],
    );
  } finally {
    cleanup();
  }
});

// ===== 與 JsonLogger（T001）整合 =====

test('EventLogger 與 JsonLogger 共存（不同檔案），事件檔名固定', () => {
  const { dir, logger, cleanup } = mkLogger();
  try {
    const now = new Date();
    logger.write('system_shutdown', { reason: 'test' }, now);
    // 事件檔存在且格式為 .events.jsonl（以 Taipei 今天日期命名）
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    assert.ok(existsSync(join(dir, `${today}.events.jsonl`)));
  } finally {
    cleanup();
  }
});
