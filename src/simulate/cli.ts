#!/usr/bin/env node
// T013 模擬盤 CLI 入口：npm run test:simulate
import { simulateCli } from './simulate.js';

const code = await simulateCli(process.argv.slice(2));
process.exit(code);
