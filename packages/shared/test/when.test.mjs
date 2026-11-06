import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen } from '../dist/when.js';

const now = new Date(2026, 10, 6, 10, 15);
test('relative reminder prefixes consume only time and preserve text', () => {
  for (const [expression, milliseconds] of [['30m', 1800000], ['2h', 7200000], ['1d', 86400000]]) {
    const result = parseWhen(`in ${expression} drink water`, now);
    assert.equal(result.when.getTime(), now.getTime() + milliseconds);
    assert.equal(result.rest, 'drink water');
  }
});
test('tomorrow and at use local calendar time', () => {
  assert.equal(parseWhen('tomorrow 9am check mail', now).when.getTime(), new Date(2026, 10, 7, 9).getTime());
  assert.equal(parseWhen('tomorrow 12am midnight', now).when.getHours(), 0);
  assert.equal(parseWhen('tomorrow 12pm noon', now).when.getHours(), 12);
  const result = parseWhen('at 15:30 check mail', now);
  assert.equal(result.when.getTime(), new Date(2026, 10, 6, 15, 30).getTime());
  assert.equal(result.rest, 'check mail');
  assert.equal(parseWhen('TOMORROW 9:45 PM task', now).when.getHours(), 21);
});
test('invalid, overflowing or past times fail without guessing', () => {
  for (const expression of ['in 0m text', 'in -1h text', 'in 1.5h text', 'in 2weeks text', 'in 30minutes text', 'in 999999999999999999999999d text', 'tomorrow 13pm task', 'tomorrow 0am task', 'tomorrow 9:60am task', 'at 25:00 task', 'at 09:00 task', 'at 10:15 task', 'at 15 task', 'soon task']) assert.equal(parseWhen(expression, now), null, expression);
  assert.equal(parseWhen('in 1h text', new Date(NaN)), null);
});
test('calendar rollover and omitted reminder body', () => {
  const end = new Date(2026, 11, 31, 20);
  const result = parseWhen('tomorrow 9am', end);
  assert.equal(result.when.getTime(), new Date(2027, 0, 1, 9).getTime());
  assert.equal(result.rest, '');
});
