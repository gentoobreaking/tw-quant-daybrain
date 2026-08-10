// Phase 0 資料就緒檢查（T006，§4 Phase 0）
// - 驗證 MCP 連線（tools/list handshake）
// - 預熱：前一日盤後資料（freshness == POST_MARKET_TODAY）檢查
// - 缺口 → 依 §3.2 降級並於盤前報告註明

import type { McpCallFn, GateCheckFn, DataGap } from './types.js';

export interface Phase0Options {
  mcpCall: McpCallFn;
  /** tools/list 驗證（回傳可用工具清單；測試注入） */
  listTools: () => Promise<string[]>;
  gate: GateCheckFn;
  /** 必備工具（Phase 0 驗證；預設 Phase 1 選股所需） */
  requiredTools?: string[];
  /** 前一日盤後資料預熱之工具清單（預設 Phase 1 三路徑） */
  warmupTools?: string[];
}

export interface Phase0Result {
  connectionReady: boolean;
  toolCount: number;
  missingTools: string[];
  /** 各預熱工具之守門結果（passed / cause） */
  warmup: Array<{ tool: string; passed: boolean; cause?: string }>;
  dataGaps: DataGap[];
}

/** Phase 1 選股所需之必備工具 */
export const PHASE1_REQUIRED_TOOLS = [
  'get_institutional_investors',
  'get_abnormal_trading',
  'get_major_announcements',
  'scan_daytrade_eligibility',
  'set_active_watchlist',
];

/** 前一日盤後資料預熱工具（POST_MARKET_TODAY） */
export const PHASE0_WARMUP_TOOLS = [
  'get_institutional_investors',
  'get_abnormal_trading',
  'get_major_announcements',
];

export class Phase0ReadyCheck {
  private readonly opts: Required<
    Omit<Phase0Options, 'listTools' | 'mcpCall' | 'gate'>
  > & { listTools: Phase0Options['listTools']; mcpCall: Phase0Options['mcpCall']; gate: Phase0Options['gate'] };

  constructor(options: Phase0Options) {
    this.opts = {
      mcpCall: options.mcpCall,
      listTools: options.listTools,
      gate: options.gate,
      requiredTools: options.requiredTools ?? PHASE1_REQUIRED_TOOLS,
      warmupTools: options.warmupTools ?? PHASE0_WARMUP_TOOLS,
    };
  }

  /**
   * Phase 0 就緒檢查：
   * 1. tools/list handshake（連線驗證）
   * 2. 前一日盤後資料預熱（freshness == POST_MARKET_TODAY 檢查）
   * 缺口收集於 dataGaps，供盤前報告註明。
   */
  async run(): Promise<Phase0Result> {
    const gaps: DataGap[] = [];
    let toolCount = 0;
    let available: string[] = [];

    // 1. MCP 連線驗證（tools/list）
    try {
      available = await this.opts.listTools();
      toolCount = available.length;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      gaps.push({ tool: 'tools/list', reason: `連線驗證失敗: ${reason}` });
      return {
        connectionReady: false,
        toolCount: 0,
        missingTools: this.opts.requiredTools,
        warmup: [],
        dataGaps: gaps,
      };
    }

    // 必備工具檢查
    const missing = this.opts.requiredTools.filter((t) => !available.includes(t));
    if (missing.length > 0) {
      gaps.push({ tool: 'tools/list', reason: `缺少必備工具: ${missing.join(', ')}` });
    }

    // 2. 前一日盤後資料預熱（POST_MARKET_TODAY）
    const warmup: Phase0Result['warmup'] = [];
    for (const tool of this.opts.warmupTools) {
      if (!available.includes(tool)) {
        warmup.push({ tool, passed: false, cause: '工具不可用' });
        gaps.push({ tool, reason: '工具不可用（未於 tools/list）' });
        continue;
      }
      try {
        const env = await this.opts.mcpCall(tool, {});
        const r = this.opts.gate(env as never, 'PRE_MARKET', {});
        warmup.push({ tool, passed: r.passed, cause: r.passed ? undefined : r.cause });
        if (!r.passed) {
          gaps.push({
            tool,
            reason: `前一日盤後資料未就緒（${r.cause ?? '守門失敗'}）`,
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        warmup.push({ tool, passed: false, cause: reason });
        gaps.push({ tool, reason: `預熱呼叫失敗: ${reason}` });
      }
    }

    return {
      connectionReady: toolCount > 0,
      toolCount,
      missingTools: missing,
      warmup,
      dataGaps: gaps,
    };
  }
}
