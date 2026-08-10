// T021 CsvDataLoader 單元測試（§12.3）
// 覆蓋：三種時間格式、民國曆邊界（100 年以前=2 位數、3 位數）、SHARES 轉 LOTS、重複戳記、
//       非交易時段濾除、目錄批量載入、壞列 warning、欄位別名（中文欄）、檔案不存在 throw
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CsvDataLoader, parseAndNormalizeTimestamp, deduplicateAndSort, minguoYearToGregorian } from './data_loader.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 't021-'));
}

async function writeCsv(dir: string, name: string, content: string): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, content, 'utf-8');
  return p;
}

// ---- 時間解析（§12.3-1） ----
test('parseAndNormalizeTimestamp：ISO 空白分隔 → +08:00', () => {
  assert.equal(parseAndNormalizeTimestamp('2026-07-31 09:00:00'), '2026-07-31T09:00:00+08:00');
});

test('parseAndNormalizeTimestamp：斜線分隔（YYYY/MM/DD HH:mm）', () => {
  assert.equal(parseAndNormalizeTimestamp('2026/07/31 09:00'), '2026-07-31T09:00:00+08:00');
});

test('parseAndNormalizeTimestamp：民國曆 3 位數（115/07/31 09:00 → 2026）', () => {
  assert.equal(parseAndNormalizeTimestamp('115/07/31 09:00'), '2026-07-31T09:00:00+08:00');
});

test('parseAndNormalizeTimestamp：民國曆 2 位數（15/07/31 → 1926）', () => {
  assert.equal(parseAndNormalizeTimestamp('15/07/31 09:00'), '1926-07-31T09:00:00+08:00');
});

test('parseAndNormalizeTimestamp：民國曆 100 年以前邊界（100 → 2011、99 → 2010）', () => {
  assert.equal(parseAndNormalizeTimestamp('100/01/02 09:30'), '2011-01-02T09:30:00+08:00');
  assert.equal(parseAndNormalizeTimestamp('99/12/31 13:25'), '2010-12-31T13:25:00+08:00');
});

test('minguoYearToGregorian：民國 1 = 1912、100 = 2011、115 = 2026', () => {
  assert.equal(minguoYearToGregorian(1), 1912);
  assert.equal(minguoYearToGregorian(100), 2011);
  assert.equal(minguoYearToGregorian(115), 2026);
});

test('parseAndNormalizeTimestamp：無效輸入回 null', () => {
  assert.equal(parseAndNormalizeTimestamp(''), null);
  assert.equal(parseAndNormalizeTimestamp('not-a-date'), null);
});

// ---- 去重與排序（§12.3-3） ----
test('deduplicateAndSort：重複戳記取首筆 + 順向排序', () => {
  const bars = [
    { symbol: '2308', datetime: '2026-07-31T09:02:00+08:00', open: 2, high: 2, low: 2, close: 2, volume: 2 },
    { symbol: '2308', datetime: '2026-07-31T09:00:00+08:00', open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { symbol: '2308', datetime: '2026-07-31T09:01:00+08:00', open: 3, high: 3, low: 3, close: 3, volume: 3 },
    { symbol: '2308', datetime: '2026-07-31T09:00:00+08:00', open: 9, high: 9, low: 9, close: 9, volume: 9 },
  ];
  const out = deduplicateAndSort(bars);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((b) => b.datetime), [
    '2026-07-31T09:00:00+08:00',
    '2026-07-31T09:01:00+08:00',
    '2026-07-31T09:02:00+08:00',
  ]);
  assert.equal(out[0].volume, 1, '重複戳記保留首筆');
});

// ---- loadCsvFile 整合 ----
test('loadCsvFile：標準格式 + 交易時段濾除 + 排序', async () => {
  const dir = await tmpDir();
  const p = await writeCsv(dir, '2308.csv', [
    'datetime,open,high,low,close,volume',
    '2026-07-31 09:01:00,1635.0,1645.0,1635.0,1640.0,320',
    '2026-07-31 09:00:00,1630.0,1640.0,1625.0,1635.0,450',
    '2026-07-31 08:55:00,1620.0,1625.0,1618.0,1622.0,100', // 盤前 → 濾除
    '2026-07-31 13:35:00,1620.0,1625.0,1618.0,1622.0,100', // 盤後 → 濾除
    '2026-07-31 13:30:00,1622.0,1630.0,1620.0,1625.0,88',  // 邊界保留
  ].join('\n'));
  const loader = new CsvDataLoader();
  const bars = await loader.loadCsvFile(p, '2308');
  assert.equal(bars.length, 3);
  assert.equal(bars[0].datetime, '2026-07-31T09:00:00+08:00');
  assert.equal(bars[0].symbol, '2308');
  assert.equal(bars[0].open, 1630);
  assert.equal(bars[0].volume, 450);
  assert.equal(bars[2].datetime, '2026-07-31T13:30:00+08:00');
});

test('loadCsvFile：民國曆 + 斜線格式混用', async () => {
  const dir = await tmpDir();
  const p = await writeCsv(dir, '2317.csv', [
    'datetime,open,high,low,close,volume',
    '115/07/31 09:00,100.0,101.0,99.5,100.5,100',
    '115/07/31 09:01,100.5,102.0,100.5,101.5,200',
  ].join('\n'));
  const loader = new CsvDataLoader();
  const bars = await loader.loadCsvFile(p, '2317');
  assert.equal(bars.length, 2);
  assert.equal(bars[0].datetime, '2026-07-31T09:00:00+08:00');
  assert.equal(bars[0].close, 100.5);
});

test('loadCsvFile：SHARES 單位 → ÷1000 轉張', async () => {
  const dir = await tmpDir();
  const p = await writeCsv(dir, '2308.csv', [
    'datetime,open,high,low,close,volume',
    '2026-07-31 09:00:00,1630.0,1640.0,1625.0,1635.0,450000',
  ].join('\n'));
  const loader = new CsvDataLoader({ volumeUnit: 'SHARES' });
  const bars = await loader.loadCsvFile(p, '2308');
  assert.equal(bars[0].volume, 450); // 450000 股 ÷ 1000 = 450 張
});

test('loadCsvFile：LOTS 單位原值保留', async () => {
  const dir = await tmpDir();
  const p = await writeCsv(dir, '2308.csv', [
    'datetime,open,high,low,close,volume',
    '2026-07-31 09:00:00,1630.0,1640.0,1625.0,1635.0,450',
  ].join('\n'));
  const loader = new CsvDataLoader({ volumeUnit: 'LOTS' });
  const bars = await loader.loadCsvFile(p, '2308');
  assert.equal(bars[0].volume, 450);
});

test('loadCsvFile：中文欄位別名（開盤價/收盤價/成交量）', async () => {
  const dir = await tmpDir();
  const p = await writeCsv(dir, '2308.csv', [
    '日期,開盤價,最高價,最低價,收盤價,成交量',
    '2026/07/31 09:00,1630,1640,1625,1635,450',
  ].join('\n'));
  const loader = new CsvDataLoader();
  const bars = await loader.loadCsvFile(p, '2308');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].open, 1630);
  assert.equal(bars[0].close, 1635);
  assert.equal(bars[0].volume, 450);
});

test('loadCsvFile：time/vol 別名（FinMind 風格）', async () => {
  const dir = await tmpDir();
  const p = await writeCsv(dir, '2308.csv', [
    'time,open,high,low,close,vol',
    '2026-07-31 09:00:00,1630.0,1640.0,1625.0,1635.0,450',
  ].join('\n'));
  const loader = new CsvDataLoader();
  const bars = await loader.loadCsvFile(p, '2308');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].datetime, '2026-07-31T09:00:00+08:00');
  assert.equal(bars[0].volume, 450);
});

test('loadCsvFile：壞列跳過附 warning（含列號），不中斷載入', async () => {
  const dir = await tmpDir();
  const p = await writeCsv(dir, '2308.csv', [
    'datetime,open,high,low,close,volume',
    '2026-07-31 09:00:00,1630.0,1640.0,1625.0,1635.0,450',
    'BAD-LINE,1630.0,1640.0,1625.0,1635.0,450',       // 時間無法解析
    '2026-07-31 09:02:00,abc,1640.0,1625.0,1635.0,450', // 價格 NaN
    '2026-07-31 09:03:00,1640.0,1645.0,1635.0,1640.0,320',
  ].join('\n'));
  const warns: string[] = [];
  const loader = new CsvDataLoader({ warn: (m) => warns.push(m) });
  const bars = await loader.loadCsvFile(p, '2308');
  assert.equal(bars.length, 2, '兩列壞列跳過，其餘載入');
  assert.equal(warns.length, 2);
  assert.match(warns[0], /第 3 列/);
  assert.match(warns[0], /時間格式/);
  assert.match(warns[1], /第 4 列/);
});

test('loadCsvFile：找不到檔案 → throw', async () => {
  const loader = new CsvDataLoader();
  await assert.rejects(() => loader.loadCsvFile('/nonexistent/2308.csv', '2308'), /找不到 CSV 檔案/);
});

test('loadCsvFile：空檔案/僅標頭 → 空陣列', async () => {
  const dir = await tmpDir();
  const p = await writeCsv(dir, '2308.csv', 'datetime,open,high,low,close,volume\n');
  const loader = new CsvDataLoader();
  const bars = await loader.loadCsvFile(p, '2308');
  assert.deepEqual(bars, []);
});

// ---- loadDirectory（§12.3 目錄批量） ----
test('loadDirectory：依檔名前 4–6 位數字提取 symbol + 同名合併', async () => {
  const dir = await tmpDir();
  await writeCsv(dir, '2308_20260731.csv', [
    'datetime,open,high,low,close,volume',
    '2026-07-31 09:00:00,1630.0,1640.0,1625.0,1635.0,450',
  ].join('\n'));
  await writeCsv(dir, '2308_20260803.csv', [
    'datetime,open,high,low,close,volume',
    '2026-08-03 09:00:00,1640.0,1650.0,1635.0,1645.0,500',
  ].join('\n'));
  await writeCsv(dir, '2317_20260731.csv', [
    'datetime,open,high,low,close,volume',
    '2026-07-31 09:00:00,100.0,101.0,99.5,100.5,300',
  ].join('\n'));
  await writeCsv(dir, 'notes.txt', 'not csv'); // 忽略非 csv
  await writeCsv(dir, 'AAPL_20260731.csv', 'datetime,open,high,low,close,volume\n2026-07-31 09:00:00,1,2,1,2,3'); // 非數字開頭 → 跳過

  const loader = new CsvDataLoader();
  const map = await loader.loadDirectory(dir);
  assert.deepEqual(Array.from(map.keys()).sort(), ['2308', '2317']);
  assert.equal(map.get('2308')!.length, 2, '2308 兩檔合併');
  assert.equal(map.get('2317')!.length, 1);
  assert.equal(map.get('2308')![0].datetime, '2026-07-31T09:00:00+08:00');
  assert.equal(map.get('2308')![1].datetime, '2026-08-03T09:00:00+08:00', '合併後排序');
});

// ---- 真實 fixtures（T013 提供） ----
test('loadCsvFile：testdata/historical_1m 真實 fixture 載入', async () => {
  const p = path.join(process.cwd(), 'testdata', 'historical_1m', '2308.csv');
  const loader = new CsvDataLoader();
  const bars = await loader.loadCsvFile(p, '2308');
  assert.equal(bars.length, 1350); // 5 天 × 270 分鐘
  assert.equal(bars[0].datetime, '2026-08-03T09:00:00+08:00');
  assert.equal(bars[bars.length - 1].datetime, '2026-08-07T13:29:00+08:00');
  // 全部在交易時段內 + 排序
  for (let i = 1; i < bars.length; i++) {
    assert.ok(bars[i].datetime > bars[i - 1].datetime, '時間軸順向');
  }
});
