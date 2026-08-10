import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayInTaipei, nowTimeInTaipei, isoInTaipei, hhmmInTaipei, isAtOrAfter } from './time.js';

test('todayInTaipei 回傳 YYYY-MM-DD 格式', () => {
  const d = todayInTaipei(new Date('2026-08-10T15:00:00Z'));
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  // 2026-08-10 15:00 UTC = 2026-08-10 23:00 Taipei（+8）
  assert.equal(d, '2026-08-10');
});

test('Taipei 時區跨日：UTC 16:00 = Taipei 次日 00:00', () => {
  // 2026-08-10T16:00:00Z = 2026-08-11T00:00:00+08:00
  const d = todayInTaipei(new Date('2026-08-10T16:00:00Z'));
  assert.equal(d, '2026-08-11');
});

test('nowTimeInTaipei / hhmmInTaipei 格式', () => {
  const t = nowTimeInTaipei(new Date('2026-08-10T04:30:00Z')); // 12:30 Taipei
  assert.equal(t, '12:30:00');
  assert.equal(hhmmInTaipei(new Date('2026-08-10T04:30:00Z')), '12:30');
});

test('isoInTaipei 含 +08:00 偏移', () => {
  const iso = isoInTaipei(new Date('2026-08-10T04:30:00Z'));
  assert.ok(iso.endsWith('+08:00'));
  assert.ok(iso.startsWith('2026-08-10T12:30:00'));
});

test('isAtOrAfter 字串比較', () => {
  const now = new Date('2026-08-10T04:00:00Z'); // 12:00 Taipei
  assert.equal(isAtOrAfter('12:00', now), true);
  assert.equal(isAtOrAfter('12:01', now), false);
  assert.equal(isAtOrAfter('11:59', now), true);
});
