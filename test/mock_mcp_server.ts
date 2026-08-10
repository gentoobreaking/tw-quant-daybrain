// Mock MCP Server（T002 整合測試用）
// 以 @modelcontextprotocol/sdk 實作 Stdio MCP server，錄製 mcp v1.3 Envelope fixtures。
// 支援：
//   - tools/list 回傳 §2.2 全部 18 個工具
//   - 每個工具回傳對應之 Envelope fixture（data/_lineage/_chart_meta）
//   - 特殊控制：以 symbol 觸發錯誤路徑（mock_error / mock_timeout / mock_unknown_source）

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

const TOOLS: Tool[] = [
  { name: 'set_active_watchlist', description: '設定觀察清單（1~15 檔）', inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } } } },
  { name: 'get_intraday_vwap', description: '當日 VWAP', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'detect_volume_surge', description: '爆量偵測', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'get_intraday_quote', description: '即時報價', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'get_intraday_kline', description: '即時 K 線', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'get_market_summary', description: '市場彙總', inputSchema: { type: 'object' } },
  { name: 'get_futures_daily_ohlc', description: '台指期 OHLC', inputSchema: { type: 'object', properties: { contract: { type: 'string' } } } },
  { name: 'get_put_call_ratio', description: '買賣權比', inputSchema: { type: 'object' } },
  { name: 'get_institutional_investors', description: '三大法人', inputSchema: { type: 'object' } },
  { name: 'get_major_announcements', description: '重大訊息', inputSchema: { type: 'object' } },
  { name: 'get_abnormal_trading', description: '異常成交量', inputSchema: { type: 'object' } },
  { name: 'get_stock_daily_kline', description: '盤後日 K', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'scan_daytrade_eligibility', description: '當沖資格', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'get_trading_calendar', description: '交易日曆', inputSchema: { type: 'object' } },
  { name: 'get_symbol_list', description: '代碼表', inputSchema: { type: 'object' } },
  { name: 'get_pre_market_quote', description: '盤前試撮', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'get_taifex_night', description: '台指夜盤', inputSchema: { type: 'object' } },
  { name: 'get_us_market', description: '美股', inputSchema: { type: 'object' } },
];

/** 產生一個帶目前時間戳的 Envelope fixture */
function env<T>(data: T, lineage: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    data,
    _lineage: {
      source: 'TWSE',
      freshness: 'REALTIME_INTRADAY',
      fetched_at: new Date().toISOString(),
      is_cached: false,
      ...lineage,
    },
    _chart_meta: { chart_type: 'intraday' },
  });
}

const server = new Server(
  { name: 'mock-tw-quant-mcp', version: '1.3.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const symbol = typeof args.symbol === 'string' ? args.symbol : '';

  // 錯誤路徑控制（測試用）
  if (symbol === 'mock_error') {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'boom' }) }],
      isError: true,
    };
  }
  if (symbol === 'mock_bad_json') {
    return { content: [{ type: 'text', text: 'not-json{{{' }] };
  }
  if (symbol === 'mock_unknown_source') {
    return {
      content: [{ type: 'text', text: env({ price: 100 }, { source: 'UNKNOWN_SOURCE' }) }],
    };
  }
  if (symbol === 'mock_no_lineage') {
    return { content: [{ type: 'text', text: JSON.stringify({ data: { price: 100 } }) }] };
  }

  const fixtures: Record<string, string> = {
    set_active_watchlist: env({ accepted: true, count: args.symbols ? (args.symbols as string[]).length : 0 }),
    get_intraday_vwap: env({ symbol, vwap: 105.2, high: 108.5, low: 103.0, current_price: 106.1 }),
    detect_volume_surge: env({ symbol, volumeSurgeRatio: 3.2, volumeSurgeType: 'BULLISH_SURGE', is_surge: true }),
    get_intraday_quote: env({ symbol, price: 106.1, bids: [{ price: 106.0, volume: 10 }], asks: [{ price: 106.2, volume: 5 }] }),
    get_intraday_kline: env({
      symbol,
      timeframe: '1m',
      candles: [
        { timestamp: '2026-08-10T09:30:00+08:00', open: 105, high: 106, low: 104.8, close: 105.5, volume: 1200 },
        { timestamp: '2026-08-10T09:31:00+08:00', open: 105.5, high: 106.2, low: 105.2, close: 106.1, volume: 1800 },
      ],
    }),
    get_market_summary: env({ date: '2026-08-10', advance: 600, decline: 400, unchanged: 50, limit_up: 12, limit_down: 3 }),
    get_futures_daily_ohlc: env({ contract: 'TX', date: '2026-08-10', open: 22400, high: 22500, low: 22350, close: 22480 }),
    get_put_call_ratio: env({ date: '2026-08-10', pcr_volume: 1.15, pcr_oi: 1.08 }),
    get_institutional_investors: env({ date: '2026-08-10', foreign_net: 12345, investment_trust_net: -500, dealer_net: 800 }),
    get_major_announcements: env({ announcements: [{ symbol: '2308', title: '月營收創高', date: '2026-08-10' }] }),
    get_abnormal_trading: env({ date: '2026-08-10', stocks: [{ symbol: '2308' }, { symbol: '2330' }] }),
    get_stock_daily_kline: env({ symbol, period: 'day', candles: [{ timestamp: '2026-08-07', open: 100, high: 105, low: 99, close: 104, volume: 50000 }] }),
    scan_daytrade_eligibility: env({ symbol, eligible: true, risk_status: 'NORMAL', is_attention: false, is_disposition: false }),
    get_trading_calendar: env({ year: 2026, trading_days: ['2026-08-10', '2026-08-11'], holidays: [{ date: '2026-10-10', name: '國慶日' }] }),
    get_symbol_list: env({ symbols: [{ symbol: '2330', name: '台積電', market: 'tse' }, { symbol: '2308', name: '台達電', market: 'tse' }] }),
    get_pre_market_quote: env({ symbol, pre_market_price: 105.8, pre_market_volume: 3200 }, { freshness: 'POST_MARKET_TODAY', source: 'TPEx' }),
    get_taifex_night: env({ date: '2026-08-07', open: 22300, high: 22400, low: 22250, close: 22380, change_pct: 0.4 }, { source: 'TAIFEX' }),
    get_us_market: env({ date: '2026-08-07', nvda: { price: 138.5, change_pct: 1.2 }, tsm: { price: 185.3, change_pct: -0.3 } }, { source: 'MIS' }),
  };

  const text = fixtures[name];
  if (!text) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: `unknown tool ${name}` }) }], isError: true };
  }
  return { content: [{ type: 'text', text }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
