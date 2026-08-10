import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonLogger } from './logger.js';

test('JsonLogger 寫入事件型 JSON 日誌（ts/type 欄位）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daybrain-log-'));
  try {
    const logger = new JsonLogger(dir, false);
    logger.info('boot', { version: '0.1.0' });
    logger.error('mcp_disconnect', { retry: 1 });

    const file = logger.currentFile();
    assert.ok(existsSync(file));
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);

    const e1 = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(e1.type, 'boot');
    assert.equal(e1.level, 'info');
    assert.equal(e1.version, '0.1.0');
    assert.match(String(e1.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);

    const e2 = JSON.parse(lines[1]) as Record<string, unknown>;
    assert.equal(e2.type, 'mcp_disconnect');
    assert.equal(e2.level, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonLogger 自動建立 LOG_DIR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daybrain-log2-'));
  const sub = join(dir, 'nested', 'logs');
  try {
    const logger = new JsonLogger(sub, false);
    assert.ok(existsSync(sub));
    logger.warn('test', {});
    assert.ok(existsSync(logger.currentFile()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
