#!/usr/bin/env node
// 統一 CLI 入口（T013/T015/T023/T024 + fixture 錄製）：
//   npm run cli -- <command> [options]   或   node --import tsx src/cli.ts <command> [options]
// 各命令直接委派既有 CLI 模組，本層只負責 routing + help，避免重複參數邏輯。

const HELP = `tw-quant-daybrain CLI — 台股當沖決策引擎

用法：
  npm run cli -- <command> [options]

  命令：
    start           生產部署：交易日自動執行完整流程、非交易日休眠（T005）
                    （同 npm run start，需 MCP_SERVER_BIN + 設定）
    dev             同 start，但用 tsx 直接跑原始碼
    build           編譯 TypeScript 或打包 binary
                    （無參數：編譯到 dist/；--binary：打包 dist/daybrain，需 bun）
    test            執行所有單元測試
                    （對應 npm test；需 node --test + tsx）
    lint            型別檢查 + ESLint
    typecheck       僅執行 tsc --noEmit 型別檢查
    simulate        模擬盤：以 fixture 劇本回放整日 Phase 0→4（T013）
                  --fixture <path>      fixture 檔（預設自動選 testdata/mcp/ 最新日期檔）
                  --fault <mode>        故障注入：timeout|data_gap|connection_drop（預設 none）
  fixture:record  連線 tw-quant-mcp 錄製最新交易日 fixture（盤中/盤後雙模式）
                  --date <YYYY-MM-DD>   指定交易日（預設最新交易日）
                  --out <path>          輸出位置（預設 testdata/mcp/<date>.json）
                  --symbols <a,b>       覆寫候選股
                  --ticks <n>           盤中錄製 tick 數（預設 3）
                  --tick-gap-ms <n>     tick 間隔毫秒
                  --server-bin <path>   覆寫 MCP server 二進位
  stress          壓測：以 10s tick 跑全交易日（T015）
                  --fixture <path>       fixture 檔（預設 intraday.json）
                  --tick-delay <ms>     tick 延遲（預設 2）
  experiment      參數實驗：同一 fixture 對比不同參數（T015）
                  --param <name>        參數名（volume_surge_threshold）
                  --values <a,b,c>      參數值清單
                  --fixture <path>       fixture 檔
  grid-search     參數網格搜尋（T023，需 testdata/historical_1m）
  wfo             Walk-Forward 滾動驗證（T024，需 testdata/historical_1m）
  help            顯示本說明

  範例：
    npm run cli -- simulate
    npm run cli -- simulate --fixture testdata/mcp/2026-08-13.json --fault timeout
    npm run cli -- fixture:record
    npm run cli -- stress --tick-delay 5
    npm run cli -- experiment --param volume_surge_threshold --values 3.0,2.5,3.5

  開發/部署：
    npm run build                  編譯 TypeScript → dist/
    npm run build:binary           打包單檔二進位 → dist/daybrain（需 bun）
    npm run lint                   型別檢查 + ESLint
    npm test                       執行所有單元測試
    npm run test:simulate:unit     僅執行模擬日單元測試
    直接跑二進位（等同 npm run ...）：
    ./dist/daybrain build                      # 編譯 TypeScript
    ./dist/daybrain build --binary             # 打包 binary（需 bun）
    ./dist/daybrain test                       # 執行單元測試
    ./dist/daybrain lint                       # 型別檢查 + ESLint
    ./dist/daybrain typecheck                  # 僅型別檢查
    ./dist/daybrain fixture:record             # 錄製 fixture
    ./dist/daybrain simulate --fixture testdata/mcp/2026-08-19.json
  `;

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';

if (cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === '') {
  console.log(HELP);
  process.exit(0);
}

const rest = args.slice(1);

try {
  let code: number;
  switch (cmd) {
    case 'start': {
      const { main } = await import('./index.js');
      await main();
      code = 0;
      break;
    }
    case 'dev': {
      const { main } = await import('./index.js');
      await main();
      code = 0;
      break;
    }
    case 'build': {
      const { execBuild } = await import('./ops/build_cli.js');
      code = await execBuild(rest);
      break;
    }
    case 'test': {
      const { execTest } = await import('./ops/build_cli.js');
      code = await execTest(rest);
      break;
    }
    case 'lint': {
      const { execLint } = await import('./ops/build_cli.js');
      code = await execLint(rest);
      break;
    }
    case 'typecheck': {
      const { execTypecheck } = await import('./ops/build_cli.js');
      code = await execTypecheck(rest);
      break;
    }
    case 'simulate': {
      const { simulateCli } = await import('./simulate/simulate.js');
      code = await simulateCli(rest);
      break;
    }
    case 'fixture:record':
    case 'record': {
      const { recordCli } = await import('./simulate/record_fixture.js');
      code = await recordCli(rest);
      break;
    }
    case 'stress': {
      const { runStressTest, formatStressReport } = await import('./ops/stress_test.js');
      const fixtureIdx = rest.indexOf('--fixture');
      const fixture =
        fixtureIdx >= 0 && rest[fixtureIdx + 1]
          ? rest[fixtureIdx + 1]
          : 'testdata/mcp/intraday.json';
      const delayIdx = rest.indexOf('--tick-delay');
      const tickDelayMs = delayIdx >= 0 && rest[delayIdx + 1] ? Number(rest[delayIdx + 1]) : 2;
      const report = await runStressTest(fixture, { tickDelayMs });
      console.log(formatStressReport(report));
      code = report.ok ? 0 : 1;
      break;
    }
    case 'experiment': {
      const { runParamExperiment, formatExperimentReport } = await import('./ops/param_experiment.js');
      const paramIdx = rest.indexOf('--param');
      const valuesIdx = rest.indexOf('--values');
      const fixtureIdx = rest.indexOf('--fixture');
      const paramRaw = paramIdx >= 0 ? rest[paramIdx + 1] : undefined;
      const param = paramRaw as 'volume_surge_threshold' | undefined;
      const values = valuesIdx >= 0 && rest[valuesIdx + 1]
        ? rest[valuesIdx + 1].split(',').map(Number)
        : [3.0, 2.5, 3.5];
      const fixtureRaw = fixtureIdx >= 0 ? rest[fixtureIdx + 1] : undefined;
      const fixture = fixtureRaw ?? 'testdata/mcp/intraday.json';
      if (param !== 'volume_surge_threshold') {
        console.error('用法：npm run cli -- experiment --param volume_surge_threshold --values 3.0,2.5,3.5');
        process.exit(2);
      }
      const report = await runParamExperiment(fixture, param, values);
      console.log(formatExperimentReport(report));
      code = 0;
      break;
    }
    case 'grid-search': {
      const { runGridSearchCli } = await import('./backtest/grid_search.js');
      await runGridSearchCli();
      code = 0;
      break;
    }
    case 'wfo': {
      const { runWfoCli } = await import('./backtest/wfo_optimizer.js');
      await runWfoCli();
      code = 0;
      break;
    }
    default:
      console.error(`未知命令：${cmd}\n`);
      console.log(HELP);
      process.exit(2);
  }
  process.exit(code);
} catch (err) {
  console.error(`執行失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
