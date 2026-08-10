// T008 風控系統 單元測試
// 驗收：倉位計算（§11.1）、狀態機合法/非法轉移（§11.2）、出場規則優先序（§11.3）、
//       每日上限（§11.4）、時間限制邊界（§11.5）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RISK_CONFIG,
  RiskManager,
  InMemoryPositionRepository,
  calculatePositionSize,
  canOpenPosition,
  forceFlatDirective,
  evaluateExit,
  type Position,
} from './risk_manager.js';
import { EventLogger } from '../logging/event_logger.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeLogger(): { dir: string; events: EventLogger; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'risk-test-'));
  return { dir, events: new EventLogger(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeManager(opts: Partial<ConstructorParameters<typeof RiskManager>[0]> = {}) {
  const l = makeLogger();
  const repo = new InMemoryPositionRepository();
  const mgr = new RiskManager({
    config: DEFAULT_RISK_CONFIG,
    repo,
    eventLogger: l.events,
    equity: 1_000_000,
    nowFn: () => new Date('2026-08-10T10:00:00+08:00'),
    ...opts,
  });
  return { mgr, repo, ...l };
}

/** 建立一個 ARMED 持倉 */
function armed(mgr: RiskManager, over: Partial<Position> = {}): Position {
  return mgr.armPosition({
    signal_id: 'S1',
    symbol: '2308',
    action: 'BUY_TO_OPEN',
    triggerPrice: 105,
    stopLossPrice: 100,
    targetPrice: 110,
    ...over,
  });
}

// ===== §11.1 倉位規模 =====

test('倉位規模：單筆風險 = 權益×0.5%（上限 1%），股數 = 風險÷(進場−停損)', () => {
  const cfg = DEFAULT_RISK_CONFIG;
  // 風險 = 1,000,000 × 0.5% = 5,000；每股風險 = 105-100 = 5 → 1000 股
  const r = calculatePositionSize(cfg, {
    equity: 1_000_000,
    entryPrice: 105,
    stopLossPrice: 100,
  });
  assert.equal(r.riskNtd, 5_000);
  assert.equal(r.shares, 952); // 曝險 ≤10% 下修：100,000/105 = 952.38
  assert.equal(r.exposureNtd, 99_960);
  assert.ok(r.exposurePct <= 0.10);
});

test('倉位規模：單標的曝險 ≤ 權益 10%', () => {
  const cfg = DEFAULT_RISK_CONFIG;
  const r = calculatePositionSize(cfg, {
    equity: 1_000_000,
    entryPrice: 105,
    stopLossPrice: 100,
  });
  // 曝險上限 100,000 → 952 股（100,000 / 105 = 952.38）
  assert.ok(r.exposureNtd <= 100_000);
  assert.ok(r.shares <= 952);
});

test('倉位規模：進場價=停損價 → error', () => {
  const r = calculatePositionSize(DEFAULT_RISK_CONFIG, {
    equity: 1_000_000,
    entryPrice: 100,
    stopLossPrice: 100,
  });
  assert.ok(r.error);
});

test('倉位規模：既存曝險併入 10% 檢查', () => {
  const r = calculatePositionSize(DEFAULT_RISK_CONFIG, {
    equity: 1_000_000,
    entryPrice: 105,
    stopLossPrice: 100,
    currentSymbolExposure: 90_000,
  });
  // 剩餘額度 10,000 → 95 股
  assert.ok(r.shares <= 95);
});

// ===== §11.2 狀態機 =====

test('狀態機：IDLE→SCANNING→ARMED→TRIGGERED→ENTERED→MANAGED→CLOSED→LOGGED', async () => {
  const { mgr, events, cleanup } = makeManager();
  try {
    const p = armed(mgr);
    assert.equal(p.state, 'ARMED');
    assert.equal(mgr.trigger(p, 106, 85, 75), true);
    assert.equal(p.state, 'TRIGGERED');
    const ok = await mgr.enter(p);
    assert.equal(ok, true);
    assert.equal(p.state, 'ENTERED');
    assert.ok(p.shares > 0);
    mgr.manage(p, { price: 106, vwap: 102, dayHigh: 108, extrema: 107 });
    assert.equal(p.state, 'MANAGED');
    mgr.evaluateAndClose(p, { price: 111, vwap: 102, dayHigh: 112, extrema: 111 }, '10:30');
    assert.equal(p.state, 'CLOSED');
    mgr.log(p);
    assert.equal(p.state, 'LOGGED');
    // 每次轉移寫 position_state_change
    const day = events.loadDay('2026-08-10');
    const changes = day.filter((e) => e.type === 'position_state_change');
    assert.equal(changes.length, 7); // SCANNING, ARMED, TRIGGERED, ENTERED, MANAGED, CLOSED, LOGGED
  } finally {
    cleanup();
  }
});

test('狀態機：非法轉移拋錯（TRIGGERED→LOGGED）', async () => {
  const { mgr, cleanup } = makeManager();
  try {
    const p = armed(mgr);
    mgr.trigger(p, 106, 85, 75);
    assert.throws(() => mgr.log(p), /狀態必須為 CLOSED/);
  } finally {
    cleanup();
  }
});

test('狀態機：enter 前必須 TRIGGERED', async () => {
  const { mgr, cleanup } = makeManager();
  try {
    const p = armed(mgr);
    await assert.rejects(() => mgr.enter(p), /必須為 TRIGGERED/);
  } finally {
    cleanup();
  }
});

test('狀態機：TRIGGERED→ENTERED 需人工確認；拒絕退回 ARMED', async () => {
  const { mgr, cleanup } = makeManager({
    confirmEntry: async () => false,
  });
  try {
    const p = armed(mgr);
    mgr.trigger(p, 106, 85, 75);
    const ok = await mgr.enter(p);
    assert.equal(ok, false);
    assert.equal(p.state, 'ARMED');
  } finally {
    cleanup();
  }
});

test('TRIGGERED 條件：價 < 觸發價或分數 < 門檻 → 不觸發', () => {
  const { mgr, cleanup } = makeManager();
  try {
    const p = armed(mgr);
    assert.equal(mgr.trigger(p, 104, 85, 75), false); // 價不足
    assert.equal(mgr.trigger(p, 106, 70, 75), false); // 分數不足
    assert.equal(p.state, 'ARMED');
  } finally {
    cleanup();
  }
});

// ===== §11.3 出場規則優先序 =====

test('硬停損（多）：-1.5% 觸發', () => {
  const { mgr, cleanup } = makeManager();
  try {
    const p = armed(mgr);
    mgr.trigger(p, 105, 85, 75);
    void mgr.enter(p);
    p.entry_price = 100; // 模擬進場價 100
    const ev = mgr.evaluateAndClose(p, { price: 98.4, vwap: 99, dayHigh: 102, extrema: 101 }, '10:30');
    assert.equal(ev?.exit, true);
    assert.equal(ev?.reason, 'STOP_LOSS');
    assert.equal(p.state, 'CLOSED');
  } finally {
    cleanup();
  }
});

test('硬停損（多）：跌破 VWAP 觸發（先觸發者）', () => {
  const { mgr, cleanup } = makeManager();
  try {
    const p = armed(mgr);
    mgr.trigger(p, 105, 85, 75);
    void mgr.enter(p);
    p.entry_price = 100;
    const ev = mgr.evaluateAndClose(p, { price: 99.5, vwap: 99.6, dayHigh: 102, extrema: 101 }, '10:30');
    assert.equal(ev?.reason, 'STOP_LOSS');
  } finally {
    cleanup();
  }
});

test('硬停損（空）：+1.5% 或站回 VWAP / 突破當日高點', () => {
  const { mgr, cleanup } = makeManager();
  try {
    const p = armed(mgr, { action: 'SELL_TO_OPEN', triggerPrice: 100, stopLossPrice: 105 });
    mgr.trigger(p, 100, 85, 75);
    void mgr.enter(p);
    // 站回 VWAP
    let ev = mgr.evaluateAndClose(p, { price: 100.5, vwap: 100.4, dayHigh: 102, extrema: 98 }, '10:30');
    assert.equal(ev?.reason, 'STOP_LOSS');
    // 突破當日高點（假突破失敗）
    const p2 = armed(mgr, { action: 'SELL_TO_OPEN', triggerPrice: 100, stopLossPrice: 105, position_id: 'P-2026-08-10-02' });
    mgr.trigger(p2, 100, 85, 75);
    void mgr.enter(p2);
    ev = mgr.evaluateAndClose(p2, { price: 101.5, vwap: 100, dayHigh: 101, extrema: 98 }, '10:30');
    assert.equal(ev?.reason, 'STOP_LOSS');
  } finally {
    cleanup();
  }
});

test('目標價（多）：R:R≥2:1 達標 → 部分獲利 50%，剩餘移動停利', () => {
  const { mgr, cleanup } = makeManager();
  try {
    const p = armed(mgr);
    mgr.trigger(p, 105, 85, 75);
    void mgr.enter(p);
    p.entry_price = 100;
    p.target_price = 110; // R:R 2:1（停損 100-5=95）
    const ev = mgr.evaluateAndClose(p, { price: 110, vwap: 102, dayHigh: 111, extrema: 111 }, '10:30');
    assert.equal(ev?.partialTake, true);
    assert.equal(p.partial_taken, true);
    assert.equal(p.trailing_stop_price, 100); // 剩餘 50% 移動停利啟動（成本價）
    assert.equal(p.state, 'MANAGED');
    // 追蹤更新：新高 111 → trailing 109.89（回檔 1% 停利線）
    const mid = mgr.evaluateAndClose(p, { price: 110, vwap: 102, dayHigh: 111, extrema: 111 }, '10:32');
    assert.equal(mid, null);
    assert.equal(p.trailing_stop_price, 109.89);
    // 回檔 1% 觸發移動停利
    const ev2 = mgr.evaluateAndClose(p, { price: 109.5, vwap: 102, dayHigh: 111, extrema: 111 }, '10:35');
    assert.equal(ev2?.reason, 'TRAILING_STOP');
  } finally {
    cleanup();
  }
});

test('假突破回收 → FAILED_BREAKOUT 出場', () => {
  const { mgr, cleanup } = makeManager();
  try {
    const p = armed(mgr);
    mgr.trigger(p, 105, 85, 75);
    void mgr.enter(p);
    p.entry_price = 100;
    p.failed_breakout = true;
    const ev = mgr.evaluateAndClose(p, { price: 103, vwap: 102, dayHigh: 106, extrema: 105 }, '10:30');
    assert.equal(ev?.reason, 'FAILED_BREAKOUT');
  } finally {
    cleanup();
  }
});

test('未達出場條件 → 不動作（回傳 null）', () => {
  const { mgr, cleanup } = makeManager();
  try {
    const p = armed(mgr);
    mgr.trigger(p, 105, 85, 75);
    void mgr.enter(p);
    p.entry_price = 100;
    const ev = mgr.evaluateAndClose(p, { price: 103, vwap: 101, dayHigh: 105, extrema: 103.5 }, '10:30');
    assert.equal(ev, null);
    assert.equal(p.state, 'ENTERED');
  } finally {
    cleanup();
  }
});

// ===== §11.4 每日上限 =====

test('每日虧損 -3% → DAILY_LOCKOUT（停新訊，僅管既有持倉）', async () => {
  const { mgr, events, cleanup } = makeManager();
  try {
    // 3 筆停損，每筆 -12,000（-1.2% 權益），合計 -36,000 < -30,000（-3%）
    for (let i = 0; i < 3; i++) {
      const p = armed(mgr, { position_id: `P-2026-08-10-0${i + 1}` });
      mgr.trigger(p, 105, 85, 75);
      await mgr.enter(p);
      p.entry_price = 100;
      const ev = mgr.evaluateAndClose(p, { price: 98, vwap: 99, dayHigh: 101, extrema: 100 }, '10:30', { pnlNtd: -12_000 });
      assert.equal(ev?.reason, 'STOP_LOSS');
      assert.equal(p.state, 'CLOSED');
    }
    assert.equal(mgr.dailyState().dailyLockout, true);
    const gate = mgr.canOpenNewPosition('BUY_TO_OPEN', '10:40');
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /DAILY_LOCKOUT/);
    const day = events.loadDay('2026-08-10');
    assert.ok(day.some((e) => e.type === 'daily_lockout'));
  } finally {
    cleanup();
  }
});

test('連 3 筆停損 → 次日倉位 50%', async () => {
  const { mgr, cleanup } = makeManager();
  try {
    for (let i = 0; i < 3; i++) {
      const p = armed(mgr, { position_id: `P-C-${i}` });
      mgr.trigger(p, 105, 85, 75);
      await mgr.enter(p);
      p.entry_price = 100;
      mgr.evaluateAndClose(p, { price: 98, vwap: 99, dayHigh: 101, extrema: 100 }, '10:30', { pnlNtd: -5_000 });
      assert.equal(p.state, 'CLOSED');
    }
    assert.equal(mgr.dailyState().nextDaySizeFactor, 0.5);
  } finally {
    cleanup();
  }
});

test('單日交易次數上限 10：超出後僅保留出場管理', async () => {
  const { mgr, cleanup } = makeManager();
  try {
    for (let i = 0; i < 10; i++) {
      const p = armed(mgr, { position_id: `P-X-${i}` });
      mgr.trigger(p, 105, 85, 75);
      await mgr.enter(p);
      mgr.close(p, 'TAKE_PROFIT', {});
    }
    const gate = mgr.canOpenNewPosition('BUY_TO_OPEN', '11:00');
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /單日交易次數上限/);
  } finally {
    cleanup();
  }
});

// ===== §11.5 時間限制 =====

test('時間限制：09:00–09:05 不進場（開盤緩衝）', () => {
  const cfg = DEFAULT_RISK_CONFIG;
  assert.equal(canOpenPosition(cfg, '09:00', 'BUY_TO_OPEN').allowed, false);
  assert.equal(canOpenPosition(cfg, '09:04', 'BUY_TO_OPEN').allowed, false);
  assert.equal(canOpenPosition(cfg, '09:05', 'BUY_TO_OPEN').allowed, true);
});

test('時間限制：11:30 後空方停止開新空單（多方仍可）', () => {
  const cfg = DEFAULT_RISK_CONFIG;
  assert.equal(canOpenPosition(cfg, '11:29', 'SELL_TO_OPEN').allowed, true);
  assert.equal(canOpenPosition(cfg, '11:30', 'SELL_TO_OPEN').allowed, false);
  assert.equal(canOpenPosition(cfg, '11:30', 'BUY_TO_OPEN').allowed, true);
  assert.equal(canOpenPosition(cfg, '12:00', 'BUY_TO_OPEN').allowed, true);
});

test('時間限制：12:30 警示不再建倉、13:00 停發新訊、13:10 阻擋開倉', () => {
  const cfg = DEFAULT_RISK_CONFIG;
  assert.equal(canOpenPosition(cfg, '12:29', 'BUY_TO_OPEN').allowed, true);
  assert.equal(canOpenPosition(cfg, '12:30', 'BUY_TO_OPEN').allowed, false);
  assert.equal(canOpenPosition(cfg, '13:00', 'BUY_TO_OPEN').allowed, false);
  assert.equal(canOpenPosition(cfg, '13:10', 'BUY_TO_OPEN').allowed, false);
});

test('時間限制：空方 13:00 強制回補、多方 13:10 FORCE_FLAT_ALL、13:20 全平', () => {
  const cfg = DEFAULT_RISK_CONFIG;
  assert.equal(forceFlatDirective(cfg, '12:59', 'SELL_TO_OPEN').force, false);
  assert.equal(forceFlatDirective(cfg, '13:00', 'SELL_TO_OPEN').force, true);
  assert.equal(forceFlatDirective(cfg, '13:00', 'BUY_TO_OPEN').force, false);
  assert.equal(forceFlatDirective(cfg, '13:10', 'BUY_TO_OPEN').force, true);
  const ev = evaluateExit;
  void ev;
});

test('時間強制出場優先於停損評估', async () => {
  const { mgr, cleanup } = makeManager();
  try {
    const p = armed(mgr, { action: 'SELL_TO_OPEN', triggerPrice: 100, stopLossPrice: 105 });
    mgr.trigger(p, 100, 85, 75);
    await mgr.enter(p);
    // 13:00 空單：即使價格未觸及停損也強制回補
    const ev = mgr.evaluateAndClose(p, { price: 99, vwap: 100, dayHigh: 101, extrema: 99 }, '13:00');
    assert.equal(ev?.reason, 'FORCE_FLAT');
  } finally {
    cleanup();
  }
});

// ===== MAX_POSITIONS =====

test('MAX_POSITIONS=2：第 3 檔開倉被拒', async () => {
  const { mgr, cleanup } = makeManager();
  try {
    for (let i = 0; i < 2; i++) {
      const p = armed(mgr, { position_id: `P-M-${i}`, symbol: `30${i}0` });
      mgr.trigger(p, 105, 85, 75);
      await mgr.enter(p);
    }
    const gate = mgr.canOpenNewPosition('BUY_TO_OPEN', '10:00');
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /MAX_POSITIONS/);
  } finally {
    cleanup();
  }
});
