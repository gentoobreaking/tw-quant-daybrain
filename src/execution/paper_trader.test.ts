// T014 紙上交單與無頭模式 測試
// 驗收：TRIGGERED→ENTERED 人工確認/headless 自動、成交價回報、simulated 標註、
//      風控拒絕、評分不足不 trigger、headless 端到端

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLogger } from '../logging/event_logger.js';
import {
  RiskManager,
  InMemoryPositionRepository,
  type RiskConfig,
} from '../risk/risk_manager.js';
import {
  PaperTrader,
  HeadlessConfirmer,
  createCliConfirmer,
} from './paper_trader.js';

function makeRisk(logDir: string, now: () => Date): RiskManager {
  const cfg: RiskConfig = {
    riskPerTrade: 0.005,
    maxRiskPerTrade: 0.01,
    maxPositions: 2,
    maxSymbolExposurePct: 0.1,
    maxDailyLossPct: 3.0,
    consecutiveStopLossLimit: 3,
    maxDailyTrades: 10,
    hardStopLossPct: 0.015,
    targetRR: 2,
    partialTakePct: 0.5,
    trailingCallbackPct: 0.01,
    timeLimits: {
      openBufferEnd: '09:05',
      shortStopNew: '11:30',
      warnNoNew: '12:30',
      hardStopNew: '13:00',
      forceFlatAll: '13:10',
      forceFlatRemind: '13:15',
      forceFlatFinal: '13:20',
    },
  };
  return new RiskManager({
    config: cfg,
    repo: new InMemoryPositionRepository(),
    eventLogger: new EventLogger(logDir),
    equity: 3_000_000,
    nowFn: now,
  });
}

const T0 = () => new Date('2026-08-10T10:00:00+08:00');

test('headless：TRIGGERED→ENTERED 自動確認、simulated 標註、成交價=觸發價', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 't014-headless-'));
  const events = new EventLogger(logDir);
  const risk = makeRisk(logDir, T0);
  const trader = new PaperTrader({
    risk,
    eventLogger: events,
    confirmer: new HeadlessConfirmer(),
    nowFn: T0,
  });

  const p = await trader.processSignal({
    signal_id: 'S-1',
    symbol: '2308',
    action: 'BUY_TO_OPEN',
    entry_price: 106.2,
    stop_loss_price: 104.6,
    target_price: 109.4,
    score: 82,
    threshold: 75,
  });

  assert.ok(p, 'headless 應進場');
  assert.equal(p.state, 'ENTERED');
  assert.equal(p.entry_price, 106.2); // 成交價 = 觸發價
  assert.ok(p.shares > 0);

  // position_opened 事件含 simulated + confirm_by（找 paper_trader 補充那筆）
  const opened = events.loadDay('2026-08-10').filter((e) => e.type === 'position_opened');
  assert.ok(opened.length >= 1);
  const tracked = opened.find((e) => e.confirm_by !== undefined);
  assert.ok(tracked, '應有含 confirm_by 的 position_opened');
  assert.equal(tracked.simulated, true);
  assert.equal(tracked.confirm_by, 'headless');
  assert.equal(tracked.entry_price, 106.2);
});

test('人工 CLI：y + 成交價回報 → fill_price 覆寫、simulated=false', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 't014-cli-'));
  const events = new EventLogger(logDir);
  const risk = makeRisk(logDir, T0);
  const answers: string[] = ['y', '105.5'];
  const confirmer = createCliConfirmer(
    async () => answers.shift() ?? 'y',
    () => {},
  );
  const trader = new PaperTrader({
    risk,
    eventLogger: events,
    confirmer,
    nowFn: T0,
  });

  const p = await trader.processSignal({
    signal_id: 'S-2',
    symbol: '2317',
    action: 'BUY_TO_OPEN',
    entry_price: 101.0,
    stop_loss_price: 99.5,
    score: 80,
  });

  assert.ok(p, '人工確認應進場');
  assert.equal(p.entry_price, 105.5); // 覆寫成交價
  const opened = events.loadDay('2026-08-10').filter((e) => e.type === 'position_opened');
  const tracked = opened.find((e) => e.confirm_by !== undefined);
  assert.ok(tracked, '應有含 confirm_by 的 position_opened');
  assert.equal(tracked.confirm_by, 'cli');
  assert.equal(tracked.simulated, undefined); // 人工確認非模擬
});

test('人工拒絕：n → 不進場、退回 ARMED', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 't014-reject-'));
  const risk = makeRisk(logDir, T0);
  const confirmer = createCliConfirmer(async () => 'n', () => {});
  const trader = new PaperTrader({
    risk,
    eventLogger: new EventLogger(logDir),
    confirmer,
    nowFn: T0,
  });

  const p = await trader.processSignal({
    signal_id: 'S-3',
    symbol: '2308',
    action: 'BUY_TO_OPEN',
    entry_price: 106.2,
    stop_loss_price: 104.6,
    score: 85,
  });
  assert.equal(p, null);
  assert.equal(risk.openPositions().length, 0);
});

test('風控拒絕：maxPositions 已滿 → 不進場', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 't014-full-'));
  const events = new EventLogger(logDir);
  const risk = makeRisk(logDir, T0);
  const trader = new PaperTrader({
    risk,
    eventLogger: events,
    confirmer: new HeadlessConfirmer(),
    nowFn: T0,
  });

  // 先滿兩檔
  await trader.processSignal({
    signal_id: 'A', symbol: '2308', action: 'BUY_TO_OPEN',
    entry_price: 106.2, stop_loss_price: 104.6, score: 85,
  });
  await trader.processSignal({
    signal_id: 'B', symbol: '2317', action: 'BUY_TO_OPEN',
    entry_price: 101.0, stop_loss_price: 99.5, score: 85,
  });
  assert.equal(risk.openPositions().length, 2);

  // 第三檔被拒
  const p3 = await trader.processSignal({
    signal_id: 'C', symbol: '2330', action: 'BUY_TO_OPEN',
    entry_price: 500, stop_loss_price: 492, score: 85,
  });
  assert.equal(p3, null);
  assert.equal(risk.openPositions().length, 2);
});

test('評分不足：score < threshold → 不 trigger、不進場', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 't014-lowscore-'));
  const risk = makeRisk(logDir, T0);
  const trader = new PaperTrader({
    risk,
    eventLogger: new EventLogger(logDir),
    confirmer: new HeadlessConfirmer(),
    nowFn: T0,
  });

  const p = await trader.processSignal({
    signal_id: 'S-4',
    symbol: '2308',
    action: 'BUY_TO_OPEN',
    entry_price: 106.2,
    stop_loss_price: 104.6,
    score: 60,
    threshold: 75,
  });
  assert.equal(p, null);
  assert.equal(risk.openPositions().length, 0);
});

test('無頭模式端到端：SignalAdvice 輸入 → position_opened（simulated）', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 't014-e2e-'));
  const events = new EventLogger(logDir);
  const risk = makeRisk(logDir, T0);
  const trader = new PaperTrader({
    risk,
    eventLogger: events,
    confirmer: new HeadlessConfirmer(),
    nowFn: T0,
  });

  // 模擬 IntradayLoop 產出之 SignalAdvice 形狀
  const p = await trader.processSignal({
    signal_id: 'SIG-20260810-0001',
    symbol: '2308',
    action: 'BUY_TO_OPEN',
    entry_price: 106.2,
    stop_loss_price: 104.607,
    target_price: 109.386,
    score: 82,
    threshold: 75,
  });
  assert.ok(p);
  assert.equal(p.signal_id, 'SIG-20260810-0001');
  assert.equal(p.state, 'ENTERED');

  const day = events.loadDay('2026-08-10');
  // 事件鏈：position_state_change（SCANNING/ARMED/TRIGGERED/ENTERED）+ position_opened
  const states = day.filter((e) => e.type === 'position_state_change');
  assert.ok(states.length >= 4, `狀態轉換應 ≥4（實際 ${states.length}）`);
  const opened = day.filter((e) => e.type === 'position_opened');
  const tracked = opened.find((e) => e.confirm_by !== undefined);
  assert.ok(tracked, '應有含 confirm_by 的 position_opened');
  assert.equal(tracked.simulated, true);
});

test('v2.1 動態 force_flat_by：時間已到 → 阻擋開倉', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 't014-ffb-'));
  const events = new EventLogger(logDir);
  const risk = makeRisk(logDir, T0);
  // SHORT_ONLY → force_flat_by 13:00（§9.2）
  const trader = new PaperTrader({
    risk,
    eventLogger: events,
    confirmer: new HeadlessConfirmer(),
    forceFlatBy: '13:00',
    nowFn: () => new Date('2026-08-10T13:05:00+08:00'),
  });
  const p = await trader.processSignal({
    signal_id: 'SIG-FFB',
    symbol: '2308',
    action: 'SELL_TO_OPEN',
    entry_price: 106.2,
    stop_loss_price: 104.6,
    score: 82,
    threshold: 75,
  });
  assert.equal(p, null, '13:00 後 force_flat_by 應阻擋開倉');
  assert.equal(risk.openPositions().length, 0);
});
