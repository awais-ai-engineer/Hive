import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionInputSchema, captionParts } from '../dist/index.js';

test('continuous speech is transmitted without truncating Unicode or dropping characters', () => {
  const text = 'A release decision 🎧 '.repeat(600);
  const parts = captionParts(text);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => Array.from(part).length <= 3000));
  assert.ok(parts.every(part => !part.includes('\ufffd')));
});

test('caption segments require stable safe identifiers and bounded text', () => {
  const input = { channelId: 'channel', segmentId: 'run_0_1', text: 'Friday', final: true };
  assert.equal(captionInputSchema.safeParse(input).success, true);
  assert.equal(captionInputSchema.safeParse({ ...input, segmentId: undefined }).success, false);
  assert.equal(captionInputSchema.safeParse({ ...input, segmentId: '../escape' }).success, false);
  assert.equal(captionInputSchema.safeParse({ ...input, text: 'x'.repeat(4001) }).success, false);
});
