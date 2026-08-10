#!/usr/bin/env node
// T015 壓測 CLI：npm run stress -- [--fixture path] [--tick-delay ms]
import { runStressTest, formatStressReport } from './stress_test.js';

const args = process.argv.slice(2);
const fixtureIdx = args.indexOf('--fixture');
const fixture =
  fixtureIdx >= 0 && args[fixtureIdx + 1] ? args[fixtureIdx + 1] : 'testdata/mcp/intraday.json';
const delayIdx = args.indexOf('--tick-delay');
const tickDelayMs = delayIdx >= 0 && args[delayIdx + 1] ? Number(args[delayIdx + 1]) : 2;

const report = await runStressTest(fixture, { tickDelayMs });
console.log(formatStressReport(report));
process.exit(report.ok ? 0 : 1);
