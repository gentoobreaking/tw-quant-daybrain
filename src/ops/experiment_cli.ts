#!/usr/bin/env node
// T015 參數實驗 CLI：npm run experiment -- --param volume_surge_threshold --values 3.0,2.5,3.5
import { runParamExperiment, formatExperimentReport } from './param_experiment.js';

const args = process.argv.slice(2);
const paramIdx = args.indexOf('--param');
const valuesIdx = args.indexOf('--values');
const fixtureIdx = args.indexOf('--fixture');

const paramRaw = paramIdx >= 0 ? args[paramIdx + 1] : undefined;
const param = paramRaw as 'volume_surge_threshold' | undefined;
const values = valuesIdx >= 0 && args[valuesIdx + 1]
  ? args[valuesIdx + 1].split(',').map(Number)
  : [3.0, 2.5, 3.5];
const fixtureRaw = fixtureIdx >= 0 ? args[fixtureIdx + 1] : undefined;
const fixture = fixtureRaw ?? 'testdata/mcp/intraday.json';

if (param !== 'volume_surge_threshold') {
  console.error('用法：npm run experiment -- --param volume_surge_threshold --values 3.0,2.5,3.5');
  process.exit(2);
}

const report = await runParamExperiment(fixture, param, values);
console.log(formatExperimentReport(report));
process.exit(0);
