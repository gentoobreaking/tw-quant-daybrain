// T015 驗收項 6：與 tw-quant-mcp v1.3 工具契約相容性測試（CI 常駐）
// - 斷言 mock server 的 tools/list 回傳 = 規格書 §2.2 之 18 工具契約
// - 斷言 client 的 CONTRACT_TOOLS（src/mcp/contracts.ts）與 mock server 一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 規格書 §2.2 之 18 工具（v2.1 統一命名）
const SPEC_TOOLS = [
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

test('契約-1：mock server tools/list 覆蓋規格 §2.2 全部 18 工具', () => {
  const mock = readFileSync(join(ROOT, 'test/mock_mcp_server.ts'), 'utf-8');
  const names = [...mock.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]);
  for (const t of SPEC_TOOLS) {
    assert.ok(names.includes(t), `mock server 缺工具 ${t}`);
  }
  // 不得少於 18（可多但不可少核心契約）
  assert.ok(names.length >= 18, `mock server 工具數應 ≥ 18（實際 ${names.length}）`);
});

test('契約-2：client contracts.ts 與 spec §2.2 一致', () => {
  const contracts = readFileSync(join(ROOT, 'src/mcp/contracts.ts'), 'utf-8');
  for (const t of SPEC_TOOLS) {
    assert.ok(contracts.includes(t), `contracts.ts 缺工具 ${t}`);
  }
});

test('契約-3：mock server 版本宣告為 1.3.0（對齊 tw-quant-mcp v1.3）', () => {
  const mock = readFileSync(join(ROOT, 'test/mock_mcp_server.ts'), 'utf-8');
  assert.match(mock, /version: '1\.3\.0'/, 'mock server 應宣告 version 1.3.0');
});

test('契約-4：client 不做 tools/list 以外的版本假設（呼叫走 contract 白名單）', () => {
  const client = readFileSync(join(ROOT, 'src/mcp/client.ts'), 'utf-8');
  assert.match(client, /async call<TData/, 'client 應有泛型 call 方法');
  assert.match(client, /tool: string/, 'client.call 應接受 string tool 名');
  assert.match(client, /args: Record<string, unknown>/, 'client.call 應接受 args 物件');
});
