import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope, McpEnvelopeError, ALLOWED_LINEAGE_SOURCES } from './envelope.js';

test('parseEnvelope 正常路徑', () => {
  const raw = {
    data: { price: 105.2, vwap: 104.8 },
    _lineage: { source: 'TWSE', freshness: 'REALTIME_INTRADAY', fetched_at: '2026-08-10T09:30:00+08:00' },
    _chart_meta: { chart_type: 'intraday' },
  };
  const env = parseEnvelope('get_intraday_vwap', raw);
  assert.equal(env.data.price, 105.2);
  assert.equal(env._lineage.source, 'TWSE');
  assert.equal(env._chart_meta?.chart_type, 'intraday');
});

test('parseEnvelope 成功且 _chart_meta 為空（合法）', () => {
  const raw = {
    data: { accepted: true },
    _lineage: { source: 'TWSE', freshness: 'REALTIME_INTRADAY', fetched_at: new Date().toISOString() },
  };
  const env = parseEnvelope<{ accepted: boolean }>('set_active_watchlist', raw);
  assert.equal(env.data.accepted, true);
  assert.equal(env._chart_meta, undefined);
});

test('parseEnvelope 缺少 _lineage → McpEnvelopeError(MISSING_LINEAGE)', () => {
  assert.throws(
    () => parseEnvelope('get_intraday_vwap', { data: { price: 100 } }),
    (err: unknown) =>
      err instanceof McpEnvelopeError &&
      err.code === 'MISSING_LINEAGE' &&
      err.tool === 'get_intraday_vwap',
  );
});

test('parseEnvelope 缺少 data → McpEnvelopeError(MISSING_DATA)', () => {
  assert.throws(
    () =>
      parseEnvelope('get_intraday_vwap', {
        _lineage: { source: 'TWSE', freshness: 'REALTIME_INTRADAY', fetched_at: '2026-08-10T09:30:00+08:00' },
      }),
    (err: unknown) =>
      err instanceof McpEnvelopeError && err.code === 'MISSING_DATA',
  );
});

test('parseEnvelope 回傳非物件 → McpEnvelopeError(INVALID_ENVELOPE)', () => {
  assert.throws(
    () => parseEnvelope('get_intraday_vwap', 'not an object'),
    (err: unknown) =>
      err instanceof McpEnvelopeError && err.code === 'INVALID_ENVELOPE',
  );
  assert.throws(
    () => parseEnvelope('get_intraday_vwap', null),
    (err: unknown) =>
      err instanceof McpEnvelopeError && err.code === 'INVALID_ENVELOPE',
  );
  assert.throws(
    () => parseEnvelope('get_intraday_vwap', 42),
    (err: unknown) =>
      err instanceof McpEnvelopeError && err.code === 'INVALID_ENVELOPE',
  );
});

test('ALLOWED_LINEAGE_SOURCES 包含 TWSE/TPEx/MOPS/TAIFEX/MIS', () => {
  assert.ok(ALLOWED_LINEAGE_SOURCES.includes('TWSE'));
  assert.ok(ALLOWED_LINEAGE_SOURCES.includes('TPEx'));
  assert.ok(ALLOWED_LINEAGE_SOURCES.includes('MOPS'));
  assert.ok(ALLOWED_LINEAGE_SOURCES.includes('TAIFEX'));
  assert.ok(ALLOWED_LINEAGE_SOURCES.includes('MIS'));
});
