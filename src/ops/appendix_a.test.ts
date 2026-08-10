// 附錄 A 對齊檢查表自動化驗證（T015 驗收項 4）
// 逐項對應 tw-quant-daybrain-v2_1.md 附錄 A 五項：
//   1. Envelope 解析（data/_lineage/_chart_meta）
//   2. 盤中工具僅 09:00–13:30（timeLimits/Phase 3 收斂）
//   3. set_active_watchlist ≤ 15 檔
//   4. _lineage.source 僅官方來源；未知來源視同守門失敗
//   5. daybrain 不直接存取官方 HTTP API（全經 mcp）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_LINEAGE_SOURCES } from '../mcp/envelope.js';
import { FreshnessGate } from '../gate/freshness_gate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 收集 src/ 下所有非測試 .ts 檔內容 */
function allSrcFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.ts') && !f.name.endsWith('.test.ts')) files.push(p);
    }
  };
  walk(join(ROOT, 'src'));
  return files;
}

test('附錄 A-1：所有 MCP 回傳使用 Envelope 解析（data/_lineage/_chart_meta）', () => {
  const client = readFileSync(join(ROOT, 'src/mcp/client.ts'), 'utf-8');
  assert.match(client, /_lineage/, 'client.ts 應解析 _lineage');
  assert.match(client, /_chart_meta/, 'client.ts 應解析 _chart_meta');
  assert.match(client, /parseEnvelope|Envelope/, 'client.ts 應使用 Envelope 解析');
});

test('附錄 A-2：盤中工具僅 09:00–13:30（尾盤硬風控 13:00/13:20）', () => {
  const env = readFileSync(join(ROOT, 'src/config/env.ts'), 'utf-8');
  assert.match(env, /NO_ENTRY_AFTER.*13:00/, 'NO_ENTRY_AFTER 應為 13:00');
  assert.match(env, /FORCE_CLOSE_AT.*13:20/, 'FORCE_CLOSE_AT 應為 13:20');
  const loop = readFileSync(join(ROOT, 'src/engine/intraday_loop.ts'), 'utf-8');
  assert.match(loop, /hard_stop_new/, 'Phase 3 應有 13:00 硬停');
  assert.match(loop, /force_flat/, 'Phase 3 應有強制平倉');
});

test('附錄 A-3：set_active_watchlist 一次不超過 15 檔', () => {
  const p1 = readFileSync(join(ROOT, 'src/pre_market/phase1.ts'), 'utf-8');
  assert.match(p1, /slice\(0,\s*15\)/, 'watchlist 應截斷至 15 檔');
  assert.match(p1, /≤\s*15|<= 15|max.*15/, 'phase1 應有 ≤15 註記/限制');
});

test('附錄 A-4：_lineage.source 僅官方來源；未知來源守門失敗', () => {
  // 白名單：TWSE/TPEx/MOPS/TAIFEX/MIS
  assert.deepEqual(
    [...ALLOWED_LINEAGE_SOURCES].sort(),
    ['MIS', 'MOPS', 'TAIFEX', 'TPEx', 'TWSE'],
    'ALLOWED_LINEAGE_SOURCES 應僅含 5 個官方來源',
  );
  // FreshnessGate 對未知 source 應 fail
  const gate = new FreshnessGate({ nowFn: () => new Date() });
  const r = gate.check(
    {
      data: {},
      _lineage: {
        source: 'UNKNOWN_SOURCE',
        freshness: 'REALTIME_INTRADAY',
        fetched_at: new Date().toISOString(),
      },
    },
    'INTRADAY_SIGNAL',
    { now: new Date() },
  );
  assert.equal(r.passed, false, '未知 source 應守門失敗');
  // 連續 3 次失敗 → LOCKOUT（§3.2）
  gate.check(
    { data: {}, _lineage: { source: 'UNKNOWN_SOURCE', freshness: 'REALTIME_INTRADAY', fetched_at: new Date().toISOString() } },
    'INTRADAY_SIGNAL',
    { now: new Date() },
  );
  const r3 = gate.check(
    { data: {}, _lineage: { source: 'UNKNOWN_SOURCE', freshness: 'REALTIME_INTRADAY', fetched_at: new Date().toISOString() } },
    'INTRADAY_SIGNAL',
    { now: new Date() },
  );
  assert.equal(r3.state, 'LOCKOUT', '連續 3 次守門失敗應進入 LOCKOUT');
});

test('附錄 A-5：daybrain 不直接存取官方 HTTP API（全經 mcp）', () => {
  const src = allSrcFiles().join('\n');
  // 禁止官方 API 網域直連
  for (const host of ['twse.com.tw', 'tpex.org.tw', 'mopsfin.twse.com.tw', 'taifex.com.tw', 'openapi.twse.com.tw']) {
    assert.ok(!src.includes(`https://${host}`) && !src.includes(`http://${host}`), `不應直連 ${host}`);
  }
  // 除 simulate/trading_calendar 的注入 fetchFn 外，src 不應有 fetch 直呼官方
  const fetches = src.match(/fetch\(/g) ?? [];
  assert.ok(fetches.length <= 3, `fetch( 出現次數應極少（實際 ${fetches.length}）`);
});
