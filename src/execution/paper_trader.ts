// 紙上交單核心（T014，§18.3 Human-in-the-loop）
// - 讀取 signal_issued 建議 → RiskManager.armPosition → trigger → 人工確認/headless → enter
// - 系統不自動下單（§1 原則 4）：紙上交單僅記錄決策，不觸碰券商 API
// - 回報成交價：人工 CLI 輸入或 headless 自動「建議成交價 = 觸發價」+ simulated 標註

import { EventLogger } from '../logging/event_logger.js';
import {
  RiskManager,
  type Position,
} from '../risk/risk_manager.js';
import { isoInTaipei } from '../utils/time.js';

/** 進場確認結果（人工或 headless） */
export interface EntryConfirmation {
  approved: boolean;
  /** 實際成交價（人工回報；headless = 觸發價） */
  fill_price?: number;
  /** 是否為模擬成交（headless） */
  simulated?: boolean;
  /** 確認者（human / headless / cli） */
  by: 'human' | 'headless' | 'cli';
  note?: string;
}

/** 紙上交單確認器介面（可注入：CLI 確認、headless 自動） */
export interface EntryConfirmer {
  confirm(p: Position): Promise<EntryConfirmation>;
}

/** headless 確認器：自動回報「建議成交價 = 觸發價」並標註 simulated */
export class HeadlessConfirmer implements EntryConfirmer {
  async confirm(p: Position): Promise<EntryConfirmation> {
    return {
      approved: true,
      fill_price: p.entry_price,
      simulated: true,
      by: 'headless',
      note: 'headless 模式：建議成交價 = 觸發價（模擬）',
    };
  }
}

/**
 * CLI 確認器：stdin 詢問 y/n + 成交價回報。
 * @param input 輸入函式（測試注入；預設 process.stdin readline）
 */
export function createCliConfirmer(
  input: (prompt: string) => Promise<string> = defaultInput,
  output: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): EntryConfirmer {
  return {
    async confirm(p: Position): Promise<EntryConfirmation> {
      output(
        `[紙上交單] 訊號 ${p.signal_id} ${p.symbol} ${p.action} ` +
          `建議進場 @${p.entry_price} 停損 @${p.stop_loss_price}`,
      );
      const ans = (await input('是否進場？(y/n) > ')).trim().toLowerCase();
      if (ans === 'y' || ans === 'yes') {
        const fill = (await input('回報成交價（留空 = 觸發價）> ')).trim();
        const fillPrice = fill === '' ? p.entry_price : Number(fill);
        if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
          output('[紙上交單] 成交價無效，改用觸發價');
          return {
            approved: true,
            fill_price: p.entry_price,
            simulated: true,
            by: 'cli',
            note: '成交價輸入無效，以觸發價模擬',
          };
        }
        return {
          approved: true,
          fill_price: fillPrice,
          by: 'cli',
          note: '人工確認',
        };
      }
      return { approved: false, by: 'cli', note: '人工拒絕' };
    },
  };
}

/** 預設 stdin 讀取（readline） */
function defaultInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const readline = require('node:readline') as typeof import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

export interface PaperTraderOptions {
  risk: RiskManager;
  eventLogger: EventLogger;
  confirmer: EntryConfirmer;
  /** v2.1：動態風控參數（取自 briefing.trading_plan.active_window.force_flat_by；§7.4/§11.5） */
  forceFlatBy?: string;
  nowFn?: () => Date;
}

/**
 * 紙上交單器：signal → arm → trigger → confirm → enter。
 * 對應 §11.2 狀態機：SCANNING→ARMED→TRIGGERED→ENTERED。
 */
export class PaperTrader {
  private readonly risk: RiskManager;
  private readonly events: EventLogger;
  private readonly confirmer: EntryConfirmer;
  private readonly forceFlatBy?: string;
  private readonly nowFn: () => Date;

  constructor(opts: PaperTraderOptions) {
    this.risk = opts.risk;
    this.events = opts.eventLogger;
    this.confirmer = opts.confirmer;
    this.forceFlatBy = opts.forceFlatBy;
    this.nowFn = opts.nowFn ?? (() => new Date());
  }

  /**
   * 處理一筆訊號建議（signal_issued 的衍生輸入）。
   * @returns 進場成功之持倉；null = 未進場（風控拒絕/人工拒絕/評分不足）
   */
  async processSignal(input: {
    signal_id: string;
    symbol: string;
    action: 'BUY_TO_OPEN' | 'SELL_TO_OPEN';
    /** 觸發價（建議進場價） */
    entry_price: number;
    stop_loss_price: number;
    target_price?: number;
    /** 評分（trigger 判定用；≥ 門檻才 trigger） */
    score?: number;
    threshold?: number;
  }): Promise<Position | null> {
    // 1. 風控閘門（含 v2.1 動態 force_flat_by 檢查）
    const now = this.nowFn();
    const time = isoInTaipei(now).slice(11, 16);
    if (this.forceFlatBy && time >= this.forceFlatBy) {
      // 動態強制平倉時間已到：不再開新倉（§7.4/§11.5）
      return null;
    }
    const gate = this.risk.canOpenNewPosition(input.action, time);
    if (!gate.allowed) {
      return null;
    }

    // 2. SCANNING → ARMED（登錄持倉候選）
    const armed = this.risk.armPosition({
      signal_id: input.signal_id,
      symbol: input.symbol,
      action: input.action,
      triggerPrice: input.entry_price,
      stopLossPrice: input.stop_loss_price,
      targetPrice: input.target_price,
    });

    // 3. TRIGGERED（價 ≥ 觸發價且評分 ≥ 門檻；紙上交單以建議價視為已觸發）
    const threshold = input.threshold ?? 75;
    const triggered = this.risk.trigger(armed, input.entry_price, input.score ?? 0, threshold);
    if (!triggered) return null;

    // 4. 人工/headless 確認 → ENTERED（armed 已被 trigger 改為 TRIGGERED）
    const confirmation = await this.confirmer.confirm(armed);
    if (!confirmation.approved) {
      return null;
    }

    // 覆寫成交價（人工回報）：直接改持倉 entry_price 再 enter
    if (confirmation.fill_price && confirmation.fill_price !== armed.entry_price) {
      armed.entry_price = confirmation.fill_price;
    }

    const entered = await this.risk.enter(armed);
    if (!entered) return null;

    // 5. 寫入 position_opened 附加欄位（simulated 標註；T010 統計用）
    this.events.write('position_opened', {
      position_id: armed.position_id,
      signal_id: armed.signal_id,
      symbol: armed.symbol,
      shares: armed.shares,
      entry_price: armed.entry_price,
      action: armed.action,
      simulated: confirmation.simulated ? true : undefined,
      confirm_by: confirmation.by,
      note: confirmation.note,
    }, this.nowFn());
    return armed;
  }
}
