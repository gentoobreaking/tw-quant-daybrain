// T024 Walk-Forward Optimization CLI 入口（npm run wfo，§18.1 非交易日執行）
import { runWfoCli } from './wfo_optimizer.js';

runWfoCli().catch((err) => {
  console.error('WFO 執行失敗:', err);
  process.exit(1);
});
