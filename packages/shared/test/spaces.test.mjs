import test from 'node:test';
import assert from 'node:assert/strict';
import { preferencesPatchSchema } from '../dist/index.js';

test('space order accepts unique IDs and rejects invalid preference writes', () => {
  assert.ok(preferencesPatchSchema.safeParse({ spaceOrder: ['one', 'two'] }).success);
  assert.ok(preferencesPatchSchema.safeParse({ spaceOrder: [] }).success);
  assert.ok(preferencesPatchSchema.safeParse({}).success);
  for (const value of [{ spaceOrder: null }, { spaceOrder: ['a', 'a'] }, { spaceOrder: [''] },
    { spaceOrder: [123] }, { spaceOrder: ['a'.repeat(27)] }, { spaceOrder: Array(501).fill('a') }, { unknown: [] }]) {
    assert.equal(preferencesPatchSchema.safeParse(value).success, false);
  }
});
