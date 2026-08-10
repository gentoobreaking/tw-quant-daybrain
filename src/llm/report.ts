// LLM 檢討報告與防幻覺（T011，§16 + §4 Phase 4）
// - 輸入 = JournalEntry.summary + events（§14.4）；LLM 僅負責敘事，統計數字由
//   規則引擎注入（§16.1/§16.4），LLM 不得自行推算
// - 輸出 Schema 驗證（zod）：llm_report 為純文字敘事；數字欄位必須為 null 或
//   合理區間（§16.2）
// - symbol 白名單：LLM 提及之個股必須存在於當日 Watchlist 或 get_symbol_list
//   回傳，否則該段捨棄（§16.3）
// - 模板固定附免責聲明「僅供研究參考，不構成投資建議」（§16.5）
// - LLM 不可用（API 失敗/離線）→ 模板產生報告並標註 llm_offline（§18.3）
// - v2.0：bias_locked 事件納入檢討敘事輸入（當日方向判斷正確性對照）

import { z } from 'zod';
import type { JournalEntry, JournalSummary } from '../metrics/journal.js';
import type { DayBrainEvent } from '../logging/event_types.js';

// ===== 輸出 Schema（§16.2：純文字敘事 + 數字欄位合理區間） =====

export const LLMReportSchema = z.object({
  /** 報告 ID（日期 + 序號） */
  report_id: z.string(),
  /** 產生時間（ISO，Asia/Taipei） */
  generated_at: z.string(),
  /** 純文字敘事（LLM 產出或模板） */
  narrative: z.string().min(1),
  /** 統計數字（規則引擎注入；LLM 不得修改） */
  stats: z.object({
    trades: z.number().int().min(0),
    wins: z.number().int().min(0),
    losses: z.number().int().min(0),
    hit_rate: z.number().min(0).max(1),
    profit_factor: z.number().min(0),
    net_pnl: z.number(),
    max_drawdown_pct: z.number(),
    signals_issued: z.number().int().min(0),
  }),
  /** 當日方向判斷（bias_locked 事件） */
  bias: z
    .object({
      bias: z.enum(['LONG', 'SHORT', 'NEUTRAL']).nullable(),
      score: z.number().nullable(),
    })
    .nullable(),
  /** LLM 離線標記（§18.3） */
  llm_offline: z.boolean(),
  /** 免責聲明（§16.5，模板固定） */
  disclaimer: z.literal('僅供研究參考，不構成投資建議'),
});

export type LLMReport = z.infer<typeof LLMReportSchema>;

// ===== LLM 呼叫介面（可注入；未提供 → llm_offline fallback） =====

export interface LlmClient {
  /** 產出敘事。prompt 已含統計與事件摘要；回傳純文字 */
  generate(prompt: string): Promise<string>;
}

// ===== Symbol 白名單（§16.3） =====

export type SymbolListProvider = () => string[] | Promise<string[]>;

/** 過濾 LLM 敘事：非白名單 symbol 之段落捨棄 */
export function filterSymbols(
  narrative: string,
  whitelist: Set<string>,
): string {
  // 段落分隔（\n\n 或 \n-）
  const paragraphs = narrative.split(/\n{2,}|\n(?=- )/);
  const kept = paragraphs.filter((p) => {
    // 提及 symbol（4-6 位數字）之段落需在 whitelist
    const mentioned = p.match(/\b\d{4,6}\b/g) ?? [];
    return mentioned.every((s) => whitelist.has(s));
  });
  return kept.join('\n\n');
}

// ===== 模板（LLM 離線 / 缺省敘事） =====

export function templateNarrative(summary: JournalSummary, biasLabel: string): string {
  const lines = [
    `當日共發出 ${summary.signals_issued} 筆訊號，其中 ${summary.signals_triggered} 筆觸發，實際執行 ${summary.trades_executed} 筆交易。`,
    `勝率 ${(summary.hit_rate * 100).toFixed(1)}%（${summary.wins} 勝 / ${summary.losses} 負），Profit Factor ${summary.profit_factor.toFixed(2)}，期望值每筆 ${summary.expectancy} 元，最大回撤 ${(summary.max_drawdown_pct / 10).toFixed(1)}%。`,
    `淨損益 ${summary.net_pnl} 元（含手續費與交易稅）。`,
    `訊號轉換率 ${(summary.signal_conversion_rate * 100).toFixed(1)}%，假突破率 ${(summary.failed_breakout_rate * 100).toFixed(1)}%。`,
    `當日 Bias 判定：${biasLabel}。`,
  ];
  if (summary.trades_executed === 0) {
    lines.push('今日無交易，無個股檢討。');
  }
  return lines.join('\n');
}

// ===== 報告生成器 =====

export interface ReportOptions {
  /** LLM Client（未提供或失敗 → llm_offline 模板） */
  llm?: LlmClient;
  /** symbol 白名單來源（§16.3；預設回傳空 → 任何 symbol 段落皆捨棄） */
  symbolList?: SymbolListProvider;
  /** LLM 呼叫逾時（ms） */
  timeoutMs?: number;
}

export class LlmReportGenerator {
  private readonly llm?: LlmClient;
  private readonly symbolList?: SymbolListProvider;
  private readonly timeoutMs: number;

  constructor(opts: ReportOptions = {}) {
    this.llm = opts.llm;
    this.symbolList = opts.symbolList;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** 當日 Bias 判定（bias_locked 事件，v2.0） */
  private biasFromEvents(events: DayBrainEvent[]): { bias: 'LONG' | 'SHORT' | 'NEUTRAL'; score: number | null } | null {
    const locks = events.filter((e) => e.type === 'bias_locked');
    if (locks.length === 0) return null;
    const last = locks[locks.length - 1];
    const bias = last.bias as 'LONG' | 'SHORT' | 'NEUTRAL' | undefined;
    const score = typeof last.score === 'number' ? last.score : null;
    if (!bias) return null;
    return { bias, score };
  }

  /**
   * 生成檢討報告。
   * @param journal JournalEntry（T010 產出；llm_report 欄位將被填寫）
   * @param events 當日事件（供 bias_locked 敘事輸入）
   */
  async generate(journal: JournalEntry, events: DayBrainEvent[]): Promise<LLMReport> {
    const bias = this.biasFromEvents(events);
    const biasLabel = bias ? `${bias.bias}（score ${bias.score ?? 'n/a'}）` : '無鎖定（NEUTRAL）';

    const reportId = `${journal.date}-R1`;
    const base = {
      report_id: reportId,
      generated_at: new Date().toISOString(),
      stats: {
        trades: journal.summary.trades_executed,
        wins: journal.summary.wins,
        losses: journal.summary.losses,
        hit_rate: journal.summary.hit_rate,
        profit_factor: journal.summary.profit_factor,
        net_pnl: journal.summary.net_pnl,
        max_drawdown_pct: journal.summary.max_drawdown_pct,
        signals_issued: journal.summary.signals_issued,
      },
      bias: bias
        ? { bias: bias.bias, score: bias.score }
        : null,
      llm_offline: false,
      disclaimer: '僅供研究參考，不構成投資建議' as const,
    };

    let narrative: string;
    let llmOffline = false;

    if (this.llm) {
      try {
        // LLM 僅負責敘事；硬數字（進出場/停損/倉位/分數）直接引用 summary（§16.1）
        const prompt = this.buildPrompt(journal, biasLabel);
        const raw = await this.withTimeout(this.llm.generate(prompt));
        narrative = await this.sanitize(raw, journal);
      } catch {
        llmOffline = true;
        narrative = templateNarrative(journal.summary, biasLabel);
      }
    } else {
      llmOffline = true;
      narrative = templateNarrative(journal.summary, biasLabel);
    }

    // §16.5 免責聲明（模板固定附上）
    narrative = `${narrative}\n\n${base.disclaimer}`;

    const report: LLMReport = { ...base, narrative, llm_offline: llmOffline };
    // §16.2 輸出 Schema 驗證
    const parsed = LLMReportSchema.safeParse(report);
    if (!parsed.success) {
      throw new Error(`LLM 報告 Schema 驗證失敗: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /** LLM prompt（含統計 + 事件摘要；指示不得自行推算） */
  private buildPrompt(journal: JournalEntry, biasLabel: string): string {
    const s = journal.summary;
    return [
      '你是當沖策略檢討助手。以下統計數字全部來自規則引擎（JournalEntry.summary），你只能引用、不得自行推算或增減。',
      '',
      `日期：${journal.date}（scoring ${journal.scoring_version}）`,
      `統計：訊號 ${s.signals_issued} / 觸發 ${s.signals_triggered} / 交易 ${s.trades_executed} / 勝 ${s.wins} / 負 ${s.losses}`,
      `勝率 ${(s.hit_rate * 100).toFixed(1)}% / PF ${s.profit_factor} / 淨損益 ${s.net_pnl} / 最大回撤 ${(s.max_drawdown_pct / 10).toFixed(1)}%`,
      `訊號轉換率 ${(s.signal_conversion_rate * 100).toFixed(1)}% / 假突破率 ${(s.failed_breakout_rate * 100).toFixed(1)}%`,
      `Bias 判定：${biasLabel}`,
      '',
      '請以 3-6 句檢討：今日策略執行品質、假突破可能原因（大盤反轉/量能不足）、Bias 方向判斷正確性。不要提及任何不在當日觀察清單內的股票代碼。',
    ].join('\n');
  }

  /** 清理 LLM 輸出：白名單過濾 + 去除數字推算（§16.3/§16.4） */
  private async sanitize(raw: string, journal: JournalEntry): Promise<string> {
    let text = raw.trim();

    // symbol 白名單（§16.3）
    let whitelist = new Set<string>();
    if (this.symbolList) {
      const symbols = await this.symbolList();
      whitelist = new Set(symbols.map((s) => String(s).trim()));
    }
    // 加入當日 JournalEntry events 出現之 symbol（§16.3：當日 Watchlist 或 get_symbol_list）
    for (const e of journal.events) {
      if (e.symbol) whitelist.add(String(e.symbol));
    }
    text = filterSymbols(text, whitelist);

    // 若過濾後空 → 用模板（LLM 敘事全被捨棄）
    if (text.trim().length === 0) {
      return templateNarrative(journal.summary, 'N/A');
    }
    return text;
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('LLM 呼叫逾時')), this.timeoutMs);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }
}

/** 寫入 JournalEntry.llm_report 欄位（T010 提供之寫入介面） */
export function attachReport(journal: JournalEntry, report: LLMReport): JournalEntry {
  return { ...journal, llm_report: report.narrative };
}
