const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
for (const rate of [16000, 44100, 48000]) test(`PCM windows retain overlap without dropping samples at ${rate} Hz`, () => {
  let Processor; const frames = [];
  const sandbox = { sampleRate: rate, Float32Array, AudioWorkletProcessor: class { port = { postMessage: frame => frames.push(frame) }; }, registerProcessor: (_, value) => Processor = value };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/worklets/huddle-pcm.js'), 'utf8'), sandbox);
  const processor = new Processor();
  for (let sent = 0; sent < rate * 9; sent += 128) processor.process([[new Float32Array(Math.min(128, rate * 9 - sent)).fill(.25)]]);
  assert.equal(frames.length, 2); assert.equal(frames[0].samples.length, 80000); assert.equal(frames[1].startMs, 4000);
  assert.ok(frames[0].samples.every(value => Math.abs(value - .25) < .00001));
  processor.port.onmessage({ data: { stop: true } });
  assert.equal(frames.at(-1).done, true); assert.equal(frames.at(-2).startMs, 8000);
  assert.equal(frames.at(-2).samples.length, 16000);
  const size = frames.length; processor.process([[new Float32Array(128)]]); assert.equal(frames.length, size);
});
