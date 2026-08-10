// MCP Client 整合測試（T002）
// 使用 test/mock_mcp_server.ts（真實 Stdio 子程序）驗證：
//   - tools/list handshake（18 工具）
//   - call() Envelope 解析（data/_lineage/_chart_meta 保留）
//   - 錯誤路徑（isError / 非 JSON / 缺 _lineage / 未知 source）
//   - 重試策略（失敗後重試成功）
//   - Circuit breaker（連續 5 次失敗 → OPEN，60s 內拒絕）

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpClient, McpCallError } from './client.js';
import { McpEnvelopeError } from './envelope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(__dirname, '..', '..', 'test', 'mock_mcp_server.ts');
const TSRX_CLI = join(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

function createClient(opts: {
  retryCount?: number;
  breakerFailureThreshold?: number;
  breakerCooldownMs?: number;
  onEvent?: (e: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
} = {}): McpClient {
  return new McpClient({
    serverBin: process.execPath, // node
    serverArgs: [TSRX_CLI, MOCK_SERVER],
    retryCount: opts.retryCount ?? 2,
    breakerFailureThreshold: opts.breakerFailureThreshold ?? 5,
    breakerCooldownMs: opts.breakerCooldownMs ?? 60_000,
    onEvent: opts.onEvent,
    sleep: opts.sleep ?? (async () => {}),
  });
}

let client: McpClient;

before(async () => {
  client = createClient();
  const ok = await client.connect();
  assert.equal(ok, true);
});

after(async () => {
  await client?.close().catch(() => {});
});

test('connect: tools/list handshake 成功，18 工具可用', () => {
  assert.equal(client.state, 'CONNECTED');
  const expected = [
    'set_active_watchlist',
    'get_intraday_vwap',
    'detect_volume_surge',
    'get_intraday_quote',
    'get_intraday_kline',
    'get_market_summary',
    'get_futures_daily_ohlc',
    'get_put_call_ratio',
    'get_institutional_investors',
    'get_major_announcements',
    'get_abnormal_trading',
    'get_stock_daily_kline',
    'scan_daytrade_eligibility',
    'get_trading_calendar',
    'get_symbol_list',
    'get_pre_market_quote',
    'get_taifex_night',
    'get_us_market',
  ];
  for (const t of expected) {
    assert.ok(client.hasTool(t), `缺少工具 ${t}`);
  }
  assert.equal(client.tools.length, expected.length);
});

test('call: 解析 Envelope（data/_lineage/_chart_meta）', async () => {
  const env = await client.call<{ symbol: string; vwap: number }>('get_intraday_vwap', {
    symbol: '2308',
  });
  assert.equal(env.data.symbol, '2308');
  assert.equal(env.data.vwap, 105.2);
  assert.equal(env._lineage.source, 'TWSE');
  assert.equal(env._lineage.freshness, 'REALTIME_INTRADAY');
  assert.ok(env._lineage.fetched_at);
  assert.equal(env._chart_meta?.chart_type, 'intraday');
});

test('call: _lineage 不被丟棄（T003 輸入）', async () => {
  const env = await client.call('get_intraday_quote', { symbol: '2330' });
  assert.ok(env._lineage.fetched_at.length > 0);
  assert.equal(env._lineage.is_cached, false);
});

test('call: 盤前工具（get_pre_market_quote）freshness 為 POST_MARKET_TODAY', async () => {
  const env = await client.call<{ symbol: string }>('get_pre_market_quote', { symbol: '2308' });
  assert.equal(env.data.symbol, '2308');
  assert.equal(env._lineage.freshness, 'POST_MARKET_TODAY');
  assert.equal(env._lineage.source, 'TPEx');
});

test('call: 夜盤/美股工具 lineage source（TAIFEX / MIS）', async () => {
  const night = await client.call('get_taifex_night', {});
  assert.equal(night._lineage.source, 'TAIFEX');
  const us = await client.call('get_us_market', {});
  assert.equal(us._lineage.source, 'MIS');
});

test('call: isError=true → McpCallError', async () => {
  await assert.rejects(
    client.call('get_intraday_vwap', { symbol: 'mock_error' }),
    (err: unknown) => err instanceof McpCallError && err.tool === 'get_intraday_vwap',
  );
});

test('call: 非 JSON content → McpEnvelopeError(INVALID_ENVELOPE)', async () => {
  await assert.rejects(
    client.call('get_intraday_vwap', { symbol: 'mock_bad_json' }),
    (err: unknown) => err instanceof McpEnvelopeError && err.code === 'INVALID_ENVELOPE',
  );
});

test('call: 缺 _lineage → McpEnvelopeError(MISSING_LINEAGE)', async () => {
  await assert.rejects(
    client.call('get_intraday_vwap', { symbol: 'mock_no_lineage' }),
    (err: unknown) => err instanceof McpEnvelopeError && err.code === 'MISSING_LINEAGE',
  );
});

test('call: 未知 lineage source 仍可解析（T003 守門層判 fail）', async () => {
  const env = await client.call<{ price: number }>('get_intraday_vwap', {
    symbol: 'mock_unknown_source',
  });
  assert.equal(env.data.price, 100);
  assert.equal(env._lineage.source, 'UNKNOWN_SOURCE');
});

test('重試策略：連續失敗後成功（事件含 tool_retry）', async () => {
  const events: string[] = [];
  const c = createClient({ onEvent: (e) => events.push((e as { kind: string }).kind) });
  await c.connect();
  // 第一次失敗（mock_error）→ 重試也失敗，最終拋錯；驗證 retry 事件發生
  await assert.rejects(c.call('get_intraday_vwap', { symbol: 'mock_error' }));
  const retryEvents = events.filter((e) => e === 'tool_retry');
  assert.ok(retryEvents.length >= 1, `預期至少 1 次 tool_retry，實際 ${events.join(',')}`);
  await c.close();
});

test('重試策略：2 次重試皆失敗 → 拋 McpCallError（retried=2）', async () => {
  const c = createClient({ retryCount: 2, sleep: async () => {} });
  await c.connect();
  await assert.rejects(
    c.call('get_intraday_vwap', { symbol: 'mock_error' }),
    (err: unknown) => err instanceof McpCallError && err.retried === 2,
  );
  await c.close();
});

test('circuit breaker：連續 5 次失敗 → OPEN，60s 內拒絕呼叫', async () => {
  const events: string[] = [];
  const c = createClient({
    breakerFailureThreshold: 5,
    breakerCooldownMs: 60_000,
    sleep: async () => {},
    onEvent: (e) => events.push((e as { kind: string }).kind),
  });
  await c.connect();

  // 連續 5 次失敗（每次失敗含 2 次重試，但 breaker 以「call() 整體失敗」計數）
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(c.call('get_intraday_vwap', { symbol: 'mock_error' }));
  }

  assert.equal(c.breaker, 'OPEN');
  assert.ok(events.includes('breaker_open'));

  // breaker OPEN：立即拒絕（不實際呼叫 server）
  await assert.rejects(
    c.call('get_intraday_vwap', { symbol: '2308' }),
    (err: unknown) => err instanceof McpCallError && err.breakerOpened === true,
  );
  await c.close();
});

test('breaker 恢復：cooldown 過後可再呼叫（CLOSED）', async () => {
  const c = createClient({
    breakerFailureThreshold: 3,
    breakerCooldownMs: 0, // 立即恢復
    sleep: async () => {},
  });
  await c.connect();
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(c.call('get_intraday_vwap', { symbol: 'mock_error' }));
  }
  assert.equal(c.breaker, 'OPEN');
  // cooldown=0 → 下次呼叫自動半開試探
  const env = await c.call('get_intraday_vwap', { symbol: '2308' });
  assert.equal(env.data.vwap, 105.2);
  assert.equal(c.breaker, 'CLOSED');
  await c.close();
});
