// MCP Client 連線層（T002）
// - Stdio transport 連線（MCP_SERVER_BIN / MCP_TRANSPORT=stdio）
// - 啟動時 tools/list handshake 驗證
// - 統一呼叫封裝 call(tool, args) → { data, _lineage, _chart_meta }
// - 重試：單一 Tool 失敗重試 2 次（指數退避 1s→2s）
// - 斷線重連：指數退避 1s→30s
// - Circuit breaker：連續 5 次失敗 → 60s 暫停並通知上層降級

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseEnvelope, McpEnvelopeError, type Envelope } from './envelope.js';

/** Circuit breaker 狀態 */
export type BreakerState = 'CLOSED' | 'OPEN';
/** 連線狀態 */
export type ConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';

export interface McpClientOptions {
  /** MCP server binary 路徑（MCP_SERVER_BIN） */
  serverBin: string;
  /** MCP server 額外參數（預設 []） */
  serverArgs?: string[];
  /** 傳輸方式：stdio（v1.3 唯一支援） */
  transport?: 'stdio';
  /** 單一 Tool 失敗重試次數（預設 2） */
  retryCount?: number;
  /** 重連最大指數退避（ms，預設 30_000） */
  maxReconnectBackoffMs?: number;
  /** Circuit breaker 連續失敗次數門檻（預設 5） */
  breakerFailureThreshold?: number;
  /** Circuit breaker 暫停時間（ms，預設 60_000） */
  breakerCooldownMs?: number;
  /** 事件回呼（降級通知、重連通知等） */
  onEvent?: (event: McpClientEvent) => void;
  /** 延遲函式（測試注入） */
  sleep?: (ms: number) => Promise<void>;
}

export type McpClientEvent =
  | { kind: 'connecting' }
  | { kind: 'connected'; toolCount: number }
  | { kind: 'disconnected'; error?: string }
  | { kind: 'reconnecting'; attempt: number; backoffMs: number }
  | { kind: 'reconnected' }
  | { kind: 'breaker_open'; reason: string }
  | { kind: 'breaker_closed' }
  | { kind: 'tool_retry'; tool: string; attempt: number; error: string }
  | { kind: 'tool_failed'; tool: string; error: string };

/** MCP 呼叫失敗（結構化錯誤，含重試/breaker 資訊） */
export class McpCallError extends Error {
  readonly tool: string;
  readonly retried: number;
  readonly breakerOpened: boolean;

  constructor(
    tool: string,
    message: string,
    opts: { retried?: number; breakerOpened?: boolean; cause?: unknown } = {},
  ) {
    super(`[${tool}] ${message}`);
    this.name = 'McpCallError';
    this.tool = tool;
    this.retried = opts.retried ?? 0;
    this.breakerOpened = opts.breakerOpened ?? false;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export class McpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private readonly opts: Required<Omit<McpClientOptions, 'onEvent'>> & {
    onEvent?: McpClientOptions['onEvent'];
  };
  private breakerState: BreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private breakerOpenedAt = 0;
  private availableTools = new Set<string>();

  constructor(options: McpClientOptions) {
    this.opts = {
      serverBin: options.serverBin,
      serverArgs: options.serverArgs ?? [],
      transport: options.transport ?? 'stdio',
      retryCount: options.retryCount ?? 2,
      maxReconnectBackoffMs: options.maxReconnectBackoffMs ?? 30_000,
      breakerFailureThreshold: options.breakerFailureThreshold ?? 5,
      breakerCooldownMs: options.breakerCooldownMs ?? 60_000,
      onEvent: options.onEvent,
      sleep: options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  get state(): ConnectionState {
    if (this.client) return 'CONNECTED';
    return 'DISCONNECTED';
  }

  get breaker(): BreakerState {
    return this.breakerState;
  }

  get tools(): string[] {
    return [...this.availableTools];
  }

  private emit(event: McpClientEvent): void {
    this.opts.onEvent?.(event);
  }

  private async sleep(ms: number): Promise<void> {
    await this.opts.sleep(ms);
  }

  /** 指數退避重連延遲（1s → 2s → 4s → ... → 30s 上限） */
  private reconnectBackoffMs(attempt: number): number {
    return Math.min(1_000 * 2 ** (attempt - 1), this.opts.maxReconnectBackoffMs);
  }

  /** 建立 Stdio transport + Client，並執行 tools/list handshake */
  private async connectOnce(): Promise<void> {
    this.emit({ kind: 'connecting' });
    const transport = new StdioClientTransport({
      command: this.opts.serverBin,
      args: this.opts.serverArgs,
      stderr: 'pipe', // 不讓 server 的 stderr 污染 stdout
    });
    const client = new Client(
      { name: 'tw-quant-daybrain', version: '0.1.0' },
      { capabilities: {} },
    );
     await client.connect(transport);

    // tools/list handshake 驗證
    const { tools } = await client.listTools();
    this.availableTools = new Set(tools.map((t) => t.name));
    this.client = client;
    this.transport = transport; // 保存 transport 引用以便強制清理
    this.emit({ kind: 'connected', toolCount: tools.length });
  }

  /**
   * 啟動連線（含重連迴圈）。
   * 若 server binary 不存在或持續無法連線，重試指數退避 1s→30s，
   * 直到成功或外部中止。回傳 true 表示已連線。
   */
  async connect(): Promise<boolean> {
    let attempt = 0;
    // 先驗證 binary 存在，避免空轉
    for (;;) {
      try {
        await this.connectOnce();
        return true;
      } catch (err) {
        attempt += 1;
        const message = err instanceof Error ? err.message : String(err);
        if (this.breakerState === 'CLOSED') {
          this.registerFailure(`connect: ${message}`);
        }
        const backoff = this.reconnectBackoffMs(attempt);
        this.emit({
          kind: 'reconnecting',
          attempt,
          backoffMs: backoff,
        });
        await this.sleep(backoff);
      }
    }
  }

  /** 關閉連線 */
  async close(): Promise<void> {
    // 強制關閉 transport 並殺掉 child process
    if (this.transport) {
      try {
        const proc = (this.transport as unknown as { _process?: unknown })._process as {
          kill?: (sig: string) => void;
          stdin?: { destroy: () => void };
          stdout?: { destroy: () => void };
          stderr?: { destroy: () => void };
        } | undefined;
        // 先殺掉 child process
        proc?.kill?.('SIGKILL');
        // 再摧毀 stdio pipes（SDK close 可能未清理）
        proc?.stdin?.destroy?.();
        proc?.stdout?.destroy?.();
        proc?.stderr?.destroy?.();
      } catch {
        // ignore
      }
      const transportToClose = this.transport;
      this.transport = null;
      try {
        await transportToClose.close();
      } catch {
        // ignore
      }
    }
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    this.client = null;
  }

  /** 檢查是否有指定工具 */
  hasTool(name: string): boolean {
    return this.availableTools.has(name);
  }

  /** 單次呼叫（不重試），供 connectOnce/重試迴圈內部使用 */
  private async callOnce<TData = unknown>(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Envelope<TData>> {
    if (this.breakerState === 'OPEN') {
      const remainMs = this.breakerOpenedAt + this.opts.breakerCooldownMs - Date.now();
      if (remainMs > 0) {
        throw new McpCallError(tool, `circuit breaker OPEN（剩 ${Math.ceil(remainMs / 1000)}s）`, {
          breakerOpened: true,
        });
      }
      // cooldown 結束，嘗試半開（half-open）：允許一次試探呼叫
      this.emit({ kind: 'breaker_closed' });
      this.breakerState = 'CLOSED';
      this.consecutiveFailures = 0;
    }

    if (!this.client) {
      throw new McpCallError(tool, '未連線（client 為 null）');
    }

    const raw = (await this.client.callTool({
      name: tool,
      arguments: args,
    })) as CallToolResult;

    // MCP CallToolResult：檢查 isError
    if (raw.isError) {
      const content = Array.isArray(raw.content)
        ? raw.content.map((c) => (c as { text?: string }).text ?? '').join('')
        : '';
      throw new McpCallError(tool, content || 'MCP tool 回傳 isError=true');
    }

    // 解析 Envelope（§2.2）：data / _lineage / _chart_meta
    const text = Array.isArray(raw.content)
      ? raw.content.map((c) => (c as { text?: string }).text ?? '').join('')
      : '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new McpEnvelopeError(tool, 'INVALID_ENVELOPE', 'content 非 JSON', text);
    }
    return parseEnvelope<TData>(tool, parsed);
  }

  /** 統一呼叫封裝：重試 2 次（指數退避 1s→2s）+ breaker 計數 */
  async call<TData = unknown>(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<Envelope<TData>> {
    const maxAttempts = this.opts.retryCount + 1; // 1 次初始 + retryCount 次重試
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.callOnce<TData>(tool, args);
        // 成功：重置連續失敗計數
        if (this.consecutiveFailures > 0) {
          this.consecutiveFailures = 0;
        }
        return result;
      } catch (err) {
        // Envelope 契約違反（非 JSON / 缺 _lineage / 缺 data）：重試無意義，直接拋出
        if (err instanceof McpEnvelopeError) {
          throw err;
        }
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
          this.emit({ kind: 'tool_retry', tool, attempt, error: message });
          // 指數退避：1s → 2s
          await this.sleep(1_000 * 2 ** (attempt - 1));
        }
      }
    }

    // 全部失敗：計入 breaker
    this.registerFailure(`${tool}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    const breakerOpened = this.breakerState === 'OPEN';
    this.emit({ kind: 'tool_failed', tool, error: lastError instanceof Error ? lastError.message : String(lastError) });
    throw new McpCallError(
      tool,
      lastError instanceof Error ? lastError.message : String(lastError),
      { retried: this.opts.retryCount, breakerOpened },
    );
  }

  /** 註冊失敗：連續失敗計數 → 觸發 breaker */
  private registerFailure(reason: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.opts.breakerFailureThreshold) {
      if (this.breakerState === 'CLOSED') {
        this.breakerState = 'OPEN';
        this.breakerOpenedAt = Date.now();
        this.emit({ kind: 'breaker_open', reason });
      }
    }
  }

  /** 強制重連（斷線時呼叫；指數退避 1s→30s 由外部迴圈控制） */
  async reconnect(): Promise<boolean> {
    await this.close();
    return this.connect();
  }
}

export { McpEnvelopeError };
