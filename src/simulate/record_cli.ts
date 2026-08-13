#!/usr/bin/env node
// fixture 錄製 CLI 入口：npm run fixture:record
// 自動連線 tw-quant-mcp，錄製最新交易日 fixture 至 testdata/mcp/<date>.json
import { recordCli } from './record_fixture.js';

const code = await recordCli(process.argv.slice(2));
process.exit(code);
