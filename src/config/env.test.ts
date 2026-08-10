import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvConfig, timeToMinutes } from './env.js';

test('loadEnvConfig 使用 §17.1 預設值', () => {
  const cfg = loadEnvConfig({});
  assert.equal(cfg.TIME_ZONE, 'Asia/Taipei');
  assert.equal(cfg.MCP_SERVER_BIN, '/usr/local/bin/tw-quant-mcp');
  assert.equal(cfg.MCP_TRANSPORT, 'stdio');
  assert.equal(cfg.DATA_STALENESS_MAX_SEC, 30);
  assert.equal(cfg.SCORE_THRESHOLD, 80);
  assert.equal(cfg.NEUTRAL_SCORE_THRESHOLD, 85);
  assert.equal(cfg.BIAS_LOCK_SCORE, 50);
  assert.equal(cfg.RISK_PER_TRADE, 0.005);
  assert.equal(cfg.MAX_POSITIONS, 2);
  assert.equal(cfg.MAX_DAILY_LOSS_PCT, 3.0);
  assert.equal(cfg.TOTAL_MARGIN_POOL_NTD, 3_000_000);
  assert.equal(cfg.MAX_LEVERAGE, 2.0);
  assert.equal(cfg.SECTOR_LIMIT_PCT, 0.4);
  assert.equal(cfg.VOLUME_SURGE_THRESHOLD, 2.5);
  assert.equal(cfg.NO_ENTRY_AFTER, '13:00');
  assert.equal(cfg.FORCE_CLOSE_AT, '13:20');
  assert.equal(cfg.LOG_DIR, './logs');
  assert.equal(cfg.DATA_DIR, './data/historical_1m');
});

test('loadEnvConfig 環境變數覆寫預設值', () => {
  const cfg = loadEnvConfig({
    SCORE_THRESHOLD: '90',
    MAX_POSITIONS: '3',
    VOLUME_SURGE_THRESHOLD: '3.0',
    FORCE_CLOSE_AT: '13:25',
    LOG_DIR: '/tmp/daybrain-test-logs',
    DATA_DIR: '/tmp/daybrain-test-data',
  });
  assert.equal(cfg.SCORE_THRESHOLD, 90);
  assert.equal(cfg.MAX_POSITIONS, 3);
  assert.equal(cfg.VOLUME_SURGE_THRESHOLD, 3.0);
  assert.equal(cfg.FORCE_CLOSE_AT, '13:25');
  assert.equal(cfg.LOG_DIR, '/tmp/daybrain-test-logs');
  assert.equal(cfg.DATA_DIR, '/tmp/daybrain-test-data');
  // 未覆寫者仍為預設
  assert.equal(cfg.TIME_ZONE, 'Asia/Taipei');
  assert.equal(cfg.NO_ENTRY_AFTER, '13:00');
});

test('loadEnvConfig 拒絕無效值', () => {
  assert.throws(() => loadEnvConfig({ SCORE_THRESHOLD: 'abc' }));
  assert.throws(() => loadEnvConfig({ NO_ENTRY_AFTER: '25:00' }));
  assert.throws(() => loadEnvConfig({ MCP_TRANSPORT: 'carrier-pigeon' as string }));
  assert.throws(() => loadEnvConfig({ SECTOR_LIMIT_PCT: '1.5' }));
});

test('timeToMinutes 轉換', () => {
  assert.equal(timeToMinutes('08:15'), 495);
  assert.equal(timeToMinutes('13:20'), 800);
  assert.equal(timeToMinutes('00:00'), 0);
  assert.equal(timeToMinutes('23:59'), 1439);
});
