// T023 Grid Search CLI 入口（npm run grid-search，§18.1 非交易日執行）
import { runGridSearchCli } from './grid_search.js';

runGridSearchCli().catch((err) => {
  console.error('Grid Search 執行失敗:', err);
  process.exit(1);
});
