// 資料新鮮度守門（T003，§3）
// 以 _lineage 判定資料可用性之守門層，含降級狀態機（NORMAL / STALE / DEGRADED / LOCKOUT）。
// 守門為「決策前最後一道防線」（§1 核心原則 2），適用於 §5 Bias 決策樹與 §6/§7 策略引擎之所有 MCP 輸入。

import { ALLOWED_LINEAGE_SOURCES, type Envelope } from '../mcp/envelope.js';

/** 守門判定情境（§3.1） */
export type GateScope =
  /** 盤中訊號（常態）：freshness == REALTIME_INTRADAY + 時效 + 快取容許 */
  | 'INTRADAY_SIGNAL'
  /** 盤中市場層資料（台指期/PCR/漲跌家數）：逾時 → DEGRADED */
  | 'INTRADAY_MARKET'
  /** 盤前規劃：POST_MARKET_TODAY（前一日資料已收盤且完整） */
  | 'PRE_MARKET'
  /** 歷史回溯：HISTORICAL + data_date 覆蓋查詢範圍 */
  | 'HISTORICAL';

/** 降級狀態（§3.2） */
export type GateState = 'NORMAL' | 'STALE' | 'DEGRADED' | 'LOCKOUT';

export interface GateCheckOptions {
  /** 目前時間（測試注入；預設 new Date()） */
  now?: Date;
  /** 查詢範圍（HISTORICAL scope 用，data_date 覆蓋判斷） */
  queryRange?: { start: string; end: string };
  /** 標的 symbol（寫入事件） */
  symbol?: string;
}

export interface GateResult {
  passed: boolean;
  /** 判定後之守門狀態 */
  state: GateState;
  /** 失敗原因（passed=false 時） */
  cause?: string;
  /** fetched_at 距今秒數（lag） */
  lagSec?: number;
  /** 標的 */
  symbol?: string;
  /** 觸發之 scope */
  scope: GateScope;
}

/** 守門事件（寫入事件日誌：freshness_gate_pass|fail） */
export interface GateEvent {
  type: 'freshness_gate_pass' | 'freshness_gate_fail';
  scope: GateScope;
  symbol?: string;
  cause?: string;
  lagSec?: number;
  state: GateState;
}

export interface FreshnessGateOptions {
  /** DATA_STALENESS_MAX_SEC（預設 30） */
  stalenessMaxSec?: number;
  /** 快取容許：sampling_sec 上限（預設 10） */
  cacheSamplingSecMax?: number;
  /** 快取容許：cache_ttl 上限（預設 4） */
  cacheTtlSecMax?: number;
  /** 連續守門失敗 → LOCKOUT 之次數（預設 3） */
  lockoutFailureThreshold?: number;
  /** 守門事件回呼（寫入事件日誌） */
  onEvent?: (event: GateEvent) => void;
  /** 目前時間函式（測試注入；預設 () => new Date()） */
  nowFn?: () => Date;
}

/** 市場層工具（§3.2：台指期/PCR/漲跌家數）→ 逾時觸發 DEGRADED */
export const MARKET_LAYER_TOOLS = new Set([
  'get_futures_daily_ohlc',
  'get_put_call_ratio',
  'get_market_summary',
]);

export class FreshnessGate {
  private readonly stalenessMaxSec: number;
  private readonly cacheSamplingSecMax: number;
  private readonly cacheTtlSecMax: number;
  private readonly lockoutThreshold: number;
  private readonly onEvent?: (event: GateEvent) => void;
  private readonly nowFn: () => Date;

  private state: GateState = 'NORMAL';
  private consecutiveFailures = 0;
  private readonly staleSymbols = new Set<string>();

  private emit(event: GateEvent): void {
    this.onEvent?.(event);
  }

  constructor(options: FreshnessGateOptions = {}) {
    this.stalenessMaxSec = options.stalenessMaxSec ?? 30;
    this.cacheSamplingSecMax = options.cacheSamplingSecMax ?? 10;
    this.cacheTtlSecMax = options.cacheTtlSecMax ?? 4;
    this.lockoutThreshold = options.lockoutFailureThreshold ?? 3;
    this.onEvent = options.onEvent;
    this.nowFn = options.nowFn ?? (() => new Date());
  }

  getState(): GateState {
    return this.state;
  }

  /** 目前被標記為 STALE 之標的 */
  getStaleSymbols(): string[] {
    return [...this.staleSymbols];
  }

  /** 檢查某標的是否被 STALE 停訊 */
  isSymbolStale(symbol: string): boolean {
    return this.staleSymbols.has(symbol);
  }

  /** MCP 重連成功 / 外部恢復：重置 LOCKOUT（§18.3 重連後恢復） */
  recoverFromLockout(): void {
    if (this.state === 'LOCKOUT') {
      this.state = 'NORMAL';
      this.consecutiveFailures = 0;
    }
  }

  /** 手動恢復單一標的（如資料源恢復） */
  recoverSymbol(symbol: string): void {
    this.staleSymbols.delete(symbol);
  }

  /** 強制設定狀態（供 MCP 連線中斷時由外部呼叫 → LOCKOUT） */
  forceLockout(reason: string): void {
    this.state = 'LOCKOUT';
    this.consecutiveFailures = this.lockoutThreshold;
    this.emit({
      type: 'freshness_gate_fail',
      scope: 'INTRADAY_SIGNAL',
      cause: `lockout: ${reason}`,
      state: 'LOCKOUT',
    });
  }

  /**
   * 守門判定：驗證 Envelope 之 _lineage（§3.1）。
   * 任何引用 data 前必須通過（§2.2）。
   */
  check<TData = unknown>(
    envelope: Envelope<TData>,
    scope: GateScope,
    options: GateCheckOptions = {},
  ): GateResult {
    const now = options.now ?? this.nowFn();

    // LOCKOUT：全系統停訊
    if (this.state === 'LOCKOUT') {
      return this.fail(scope, options, 'lockout_active', 0);
    }

    const { _lineage } = envelope;

    // 附錄 A：未知 _lineage.source 視同守門失敗
    if (!ALLOWED_LINEAGE_SOURCES.includes(_lineage.source as (typeof ALLOWED_LINEAGE_SOURCES)[number])) {
      return this.fail(scope, options, 'unknown_source', 0);
    }

    // fetched_at 解析（ISO 8601）
    const fetchedAt = new Date(_lineage.fetched_at);
    if (Number.isNaN(fetchedAt.getTime())) {
      return this.fail(scope, options, 'invalid_fetched_at', 0);
    }
    const lagSec = Math.max(0, (now.getTime() - fetchedAt.getTime()) / 1000);

    // §3.1 盤前規劃
    if (scope === 'PRE_MARKET') {
      if (_lineage.freshness === 'POST_MARKET_TODAY') {
        return this.pass(scope, options, lagSec);
      }
      return this.fail(scope, options, 'freshness_mismatch', lagSec);
    }

    // §3.1 歷史回溯
    if (scope === 'HISTORICAL') {
      if (_lineage.freshness !== 'HISTORICAL') {
        return this.fail(scope, options, 'freshness_mismatch', lagSec);
      }
      const dataDate = _lineage.data_date;
      const range = options.queryRange;
      if (!dataDate) {
        return this.fail(scope, options, 'missing_data_date', lagSec);
      }
      if (range && (dataDate < range.start || dataDate > range.end)) {
        return this.fail(scope, options, 'data_date_out_of_range', lagSec);
      }
      return this.pass(scope, options, lagSec);
    }

    // §3.1 盤中訊號（INTRADAY_SIGNAL / INTRADAY_MARKET）
    if (_lineage.freshness !== 'REALTIME_INTRADAY') {
      return this.fail(scope, options, 'freshness_mismatch', lagSec);
    }

    // 快取容許規則：is_cached 時容許，但 sampling_sec ≤ 10 且 cache_ttl ≤ 4s
    if (_lineage.is_cached === true) {
      const samplingOk =
        typeof _lineage.sampling_sec === 'number' && _lineage.sampling_sec <= this.cacheSamplingSecMax;
      const ttlOk =
        typeof _lineage.cache_ttl === 'number' && _lineage.cache_ttl <= this.cacheTtlSecMax;
      if (samplingOk && ttlOk) {
        return this.pass(scope, options, lagSec);
      }
      return this.fail(scope, options, 'cache_rule_violation', lagSec);
    }

    // 時效：fetched_at 距今 ≤ DATA_STALENESS_MAX_SEC
    if (lagSec <= this.stalenessMaxSec) {
      return this.pass(scope, options, lagSec);
    }
    return this.fail(scope, options, 'stale_data', lagSec);
  }

  private pass(
    scope: GateScope,
    options: GateCheckOptions,
    lagSec: number,
  ): GateResult {
    // 成功：重置連續失敗（僅在 NORMAL/已恢復時）
    if (this.state !== 'STALE' || !options.symbol || !this.staleSymbols.has(options.symbol)) {
      // 市場層成功可恢復 DEGRADED → NORMAL（僅當無其他標的 STALE 時）
      if (this.state === 'DEGRADED' && scope === 'INTRADAY_MARKET') {
        this.state = 'NORMAL';
      }
    }
    this.consecutiveFailures = 0;
    this.emit({
      type: 'freshness_gate_pass',
      scope,
      symbol: options.symbol,
      lagSec,
      state: this.state,
    });
    return { passed: true, state: this.state, lagSec, symbol: options.symbol, scope };
  }

  private fail(
    scope: GateScope,
    options: GateCheckOptions,
    cause: string,
    lagSec: number,
  ): GateResult {
    this.consecutiveFailures += 1;

    // 狀態轉移（§3.2）
    if (this.state === 'NORMAL' || this.state === 'STALE' || this.state === 'DEGRADED') {
      if (scope === 'INTRADAY_MARKET') {
        // 市場層資料逾時 → DEGRADED（停發新訊僅管持倉）
        this.state = 'DEGRADED';
      } else if (options.symbol && cause === 'stale_data') {
        // 單一標的逾時 → STALE（該標的停訊）
        this.state = 'STALE';
        this.staleSymbols.add(options.symbol);
      }
      // 連續 3 次守門失敗 → LOCKOUT（全系統停訊）
      if (this.consecutiveFailures >= this.lockoutThreshold) {
        this.state = 'LOCKOUT';
        cause = `lockout_after_${this.consecutiveFailures}_failures`;
      }
    }

    this.emit({
      type: 'freshness_gate_fail',
      scope,
      symbol: options.symbol,
      cause,
      lagSec,
      state: this.state,
    });
    return {
      passed: false,
      state: this.state,
      cause,
      lagSec,
      symbol: options.symbol,
      scope,
    };
  }
}
