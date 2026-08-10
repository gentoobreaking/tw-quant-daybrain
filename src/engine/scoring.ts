// 訊號評分模型（T007，§8 Config-Driven 評分）
// - scoring.yaml 參數化權重/門檻（scoring_version 寫入每筆評分）
// - Veto 優先：風控條件觸發直接否決（-100），不與其他分數加總
// - 完整評分僅在雙 tick 確認後執行
// - 訊號 5 分鐘未觸發 → 過期重評（§8.3）

import { loadYamlFile, type YamlConfig } from '../config/index.js';

/** 訊號方向（§8.2 評分表之做多/做空條件） */
export type SignalDirection = 'LONG' | 'SHORT';

/** 評分等級（§8.3 門檻） */
export type SignalGrade = 'STRONG_BUY' | 'STRONG_SELL' | 'WATCH' | 'IGNORE';

/** 評分輸入（§8.2 評分表所需欄位；對齊 §6.3/§7.3 策略引擎） */
export interface ScoreInput {
  direction: SignalDirection;
  /** 位階：價 > VWAP（多）/ 價 < VWAP（空） */
  price: number;
  vwap: number;
  /** 量能：多 volumeSurgeRatio ≥ VOLUME_SURGE_THRESHOLD；空 volumeSurgeType == BEARISH_BREAKDOWN */
  volumeSurgeRatio: number;
  volumeSurgeType?: 'BEARISH_BREAKDOWN' | 'BULLISH_SURGE' | 'NEUTRAL';
  /** 突破/破位：多 價 ≥ 當日高點；空 價 < 開盤前 15 分鐘低點 */
  dayHigh: number;
  dayLow15m: number;
  /** 大盤方向：台指期 1 分 K 紅棒（多）/ 黑棒（空） */
  taifexTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** 距漲停剩餘幅度（多方向 veto：< 1.5% 扣 -50） */
  distanceToLimitUpPct?: number;
  /** 今日漲幅（空方向 veto：≥ 6.5% 否決 -100） */
  dayGainPct?: number;
  /** 通用風控（處置/注意/當沖限制/停資停券 → 否決 -100） */
  restriction?: boolean;
}

/** 評分明細（§14.2 score_breakdown，4×25 分制） */
export interface ScoreBreakdown {
  level: number;
  volume: number;
  breakout: number;
  market: number;
  /** 風控扣分項（若觸發）；v2.1 修正（v2.0 曾寫 tick_structure） */
  veto_penalty: number;
}

/** 評分輸出 */
export interface ScoreResult {
  total: number;
  breakdown: ScoreBreakdown;
  grade: SignalGrade;
  /** 觸發之 veto 原因（§8.2 風控 Veto 清單） */
  veto_reasons: string[];
  /** 是否達進場門檻（§8.3 shouldEnter） */
  shouldEnter: boolean;
  scoring_version: string;
}

/** 評分設定（自 scoring.yaml 載入，可版本化） */
export interface ScoringConfig {
  scoring_version: string;
  weights: {
    position: number;
    volume: number;
    breakout: number;
    market_direction: number;
  };
  veto: {
    long_limit_up_proximity: number;
    short_surge_lock: number;
    generic_restriction: number;
  };
  thresholds: {
    strong_buy: number;
    watch: number;
    neutral_flexible_override: number;
  };
  behavior: {
    signal_expiry_min: number;
  };
}

export interface ScoringOptions {
  /** 進場門檻覆寫（預設取 thresholds.strong_buy；NEUTRAL_FLEXIBLE 日以 neutral_flexible_override） */
  entryThreshold?: number;
  /** NEUTRAL_FLEXIBLE 日（§5.3 門檻提高至 85） */
  neutralFlexible?: boolean;
  /** VOLUME_SURGE_THRESHOLD（§17.1 env；評分時比對 volumeSurgeRatio） */
  volumeSurgeThreshold?: number;
}

const DEFAULT_SCORING: ScoringConfig = {
  scoring_version: '2.1.0',
  weights: { position: 25, volume: 25, breakout: 25, market_direction: 25 },
  veto: { long_limit_up_proximity: -50, short_surge_lock: -100, generic_restriction: -100 },
  thresholds: { strong_buy: 75, watch: 60, neutral_flexible_override: 85 },
  behavior: { signal_expiry_min: 5 },
};

/** 自 YAML 載入評分設定（缺欄位時以預設值補齊） */
export function loadScoringConfig(
  yaml: YamlConfig | undefined,
): ScoringConfig {
  if (!yaml) return DEFAULT_SCORING;
  const w = (yaml.weights ?? {}) as Record<string, unknown>;
  const v = (yaml.veto ?? {}) as Record<string, unknown>;
  const t = (yaml.thresholds ?? {}) as Record<string, unknown>;
  const b = (yaml.behavior ?? {}) as Record<string, unknown>;
  return {
    scoring_version:
      (yaml.scoring_version as string) ?? DEFAULT_SCORING.scoring_version,
    weights: {
      position: num(w.position, DEFAULT_SCORING.weights.position),
      volume: num(w.volume, DEFAULT_SCORING.weights.volume),
      breakout: num(w.breakout, DEFAULT_SCORING.weights.breakout),
      market_direction: num(w.market_direction, DEFAULT_SCORING.weights.market_direction),
    },
    veto: {
      long_limit_up_proximity: num(v.long_limit_up_proximity, DEFAULT_SCORING.veto.long_limit_up_proximity),
      short_surge_lock: num(v.short_surge_lock, DEFAULT_SCORING.veto.short_surge_lock),
      generic_restriction: num(v.generic_restriction, DEFAULT_SCORING.veto.generic_restriction),
    },
    thresholds: {
      strong_buy: num(t.strong_buy, DEFAULT_SCORING.thresholds.strong_buy),
      watch: num(t.watch, DEFAULT_SCORING.thresholds.watch),
      neutral_flexible_override: num(
        t.neutral_flexible_override,
        DEFAULT_SCORING.thresholds.neutral_flexible_override,
      ),
    },
    behavior: {
      signal_expiry_min: num(b.signal_expiry_min, DEFAULT_SCORING.behavior.signal_expiry_min),
    },
  };
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** 依設定檔載入評分設定（projectRoot 之 config/scoring.yaml） */
export function loadScoringConfigFromFile(projectRoot = process.cwd()): ScoringConfig {
  return loadScoringConfig(loadYamlFile(projectRoot, 'scoring.yaml'));
}

export class SignalScoringEngine {
  private readonly config: ScoringConfig;

  constructor(
    config?: ScoringConfig,
    private readonly opts: ScoringOptions = {},
  ) {
    this.config = config ?? DEFAULT_SCORING;
  }

  /** 進場門檻（§8.3；NEUTRAL_FLEXIBLE 日以 neutral_flexible_override） */
  entryThreshold(): number {
    if (this.opts.neutralFlexible) {
      return this.config.thresholds.neutral_flexible_override;
    }
    return this.opts.entryThreshold ?? this.config.thresholds.strong_buy;
  }

  /**
   * 評分（§8.2 評分表 + §8.3 門檻）
   * Veto 優先：-100 直接否決；long_limit_up_proximity -50 為扣分（非否決）
   */
  score(input: ScoreInput): ScoreResult {
    const w = this.config.weights;
    const veto = this.config.veto;
    const reasons: string[] = [];
    const breakdown: ScoreBreakdown = {
      level: 0,
      volume: 0,
      breakout: 0,
      market: 0,
      veto_penalty: 0,
    };

    // 1. 位階（§8.2）
    if (input.direction === 'LONG' && input.price > input.vwap) {
      breakdown.level = w.position;
    } else if (input.direction === 'SHORT' && input.price < input.vwap) {
      breakdown.level = w.position;
    }

    // 2. 量能（§8.2）
    const surgeThreshold = this.opts.volumeSurgeThreshold ?? 2.5;
    if (input.direction === 'LONG' && input.volumeSurgeRatio >= surgeThreshold) {
      breakdown.volume = w.volume;
    } else if (
      input.direction === 'SHORT' &&
      input.volumeSurgeType === 'BEARISH_BREAKDOWN'
    ) {
      breakdown.volume = w.volume;
    }

    // 3. 突破/破位（§8.2）
    if (input.direction === 'LONG' && input.price >= input.dayHigh) {
      breakdown.breakout = w.breakout;
    } else if (input.direction === 'SHORT' && input.price < input.dayLow15m) {
      breakdown.breakout = w.breakout;
    }

    // 4. 大盤方向（§8.2）
    if (input.direction === 'LONG' && input.taifexTrend === 'BULLISH') {
      breakdown.market = w.market_direction;
    } else if (input.direction === 'SHORT' && input.taifexTrend === 'BEARISH') {
      breakdown.market = w.market_direction;
    }

    // 5. 風控 Veto（§8.2）— Veto 優先
    let vetoed = false;
    if (input.direction === 'LONG' && input.distanceToLimitUpPct !== undefined) {
      if (input.distanceToLimitUpPct < 0.015) {
        breakdown.veto_penalty = veto.long_limit_up_proximity;
        reasons.push('距漲停 < 1.5%（利潤空間不足，扣分非否決）');
      }
    }
    if (input.direction === 'SHORT' && input.dayGainPct !== undefined) {
      if (input.dayGainPct >= 0.065) {
        vetoed = true;
        breakdown.veto_penalty = veto.short_surge_lock;
        reasons.push('今日漲幅 ≥ 6.5%（防軋空鎖死，否決）');
      }
    }
    if (input.restriction === true) {
      vetoed = true;
      breakdown.veto_penalty = veto.generic_restriction;
      reasons.push('處置/注意/當沖限制/停資停券（否決）');
    }

    // 總分：Veto -100 直接否決；否則 4 項加總（-50 扣分併入）
    const base = breakdown.level + breakdown.volume + breakdown.breakout + breakdown.market;
    const total = vetoed ? -100 : base + breakdown.veto_penalty;
    const grade = this.gradeOf(total);

    return {
      total,
      breakdown,
      grade,
      veto_reasons: reasons,
      shouldEnter: !vetoed && total >= this.entryThreshold(),
      scoring_version: this.config.scoring_version,
    };
  }

  /** §8.3 門檻：≥ strong_buy STRONG_BUY/SELL、60–74 WATCH、<60 IGNORE */
  gradeOf(total: number): SignalGrade {
    const t = this.config.thresholds;
    if (total >= t.strong_buy) {
      return 'STRONG_BUY';
    }
    if (total >= t.watch) {
      return 'WATCH';
    }
    return 'IGNORE';
  }
}

// ===== 雙 tick 確認（§4 Phase 2 / §8.1） =====

export interface TickConfirmState {
  symbol: string;
  /** 連續確認 tick 數（≥2 才進入完整評分） */
  confirmCount: number;
  /** 最後一次確認時間（ISO） */
  lastConfirmTs: string;
  /** 訊號產生時間（ISO；過期重評基準） */
  signalTs?: string;
  /** 是否已評分 */
  scored: boolean;
}

export class TickConfirmer {
  private readonly states = new Map<string, TickConfirmState>();

  constructor(
    private readonly requiredTicks = 2,
    private readonly nowFn: () => Date = () => new Date(),
  ) {}

  /** 記錄一次 tick 確認；回傳是否達雙 tick（true = 進入完整評分） */
  confirm(symbol: string): boolean {
    const now = this.nowFn().toISOString();
    const prev = this.states.get(symbol);
    const count = prev ? prev.confirmCount + 1 : 1;
    this.states.set(symbol, { symbol, confirmCount: count, lastConfirmTs: now, scored: false });
    return count >= this.requiredTicks;
  }

  /** 訊號產生後 5 分鐘未觸發 → 過期重評（§8.3） */
  isExpired(symbol: string, expiryMin = 5, now = this.nowFn()): boolean {
    const s = this.states.get(symbol);
    if (!s?.signalTs) return false;
    const expiryMs = expiryMin * 60_000;
    return now.getTime() - new Date(s.signalTs).getTime() >= expiryMs;
  }

  /** 標記訊號已產生（過期重評基準） */
  markSignal(symbol: string, ts = this.nowFn().toISOString()): void {
    const prev = this.states.get(symbol);
    this.states.set(symbol, {
      symbol,
      confirmCount: prev?.confirmCount ?? 0,
      lastConfirmTs: prev?.lastConfirmTs ?? ts,
      signalTs: ts,
      scored: false,
    });
  }

  /** 訊號已觸發進場（清除確認狀態） */
  consume(symbol: string): void {
    this.states.delete(symbol);
  }

  getState(symbol: string): TickConfirmState | undefined {
    return this.states.get(symbol);
  }
}
