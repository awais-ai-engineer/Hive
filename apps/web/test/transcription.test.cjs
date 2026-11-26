const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const shared = require('../../../packages/shared/dist/captions.js');
function harness() {
  const instances = [], delivered = [], statuses = [], store = new Map();
  let online = true, fail = false;
  class Recognition {
    start(track) { this.track = track; instances.push(this); this.onstart?.(); }
    stop() { queueMicrotask(() => { this.onStopping?.(); this.onend?.(); }); }
    result(entries, resultIndex = 0) { this.onresult?.({ resultIndex, results: entries.map(([text, final]) => Object.assign([{ transcript: text }], { isFinal: final })) }); }
  }
  const sandbox = { exports: {}, require: () => shared, window: { SpeechRecognition: Recognition }, crypto: require('node:crypto').webcrypto,
    sessionStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    Date, setTimeout, clearTimeout, Map, Promise };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/transcription.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, sandbox);
  const track = { id: 'selected-microphone' };
  const options = { userId: 'alice', channelId: 'channel', sessionId: 'meeting', language: () => 'en-US', track: () => track,
    connected: () => online, send: async segment => { if (fail) throw Error('offline'); delivered.push(segment); }, local() {}, status: (...args) => statuses.push(args) };
  const capture = new sandbox.exports.SpeechCapture(options);
  return { capture, instances, delivered, statuses, store, options, Capture: sandbox.exports.SpeechCapture, online: value => online = value, fail: value => fail = value, track };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('processes every recognition result with stable interim and final identifiers', async () => {
  const h = harness(); h.capture.start();
  assert.equal(h.instances[0].track, h.track);
  h.instances[0].result([['We need', false], ['Database issue', true]]);
  await settle();
  const interim = h.delivered.find(row => !row.final);
  h.instances[0].result([['We need integration', true], ['Database issue', true]]);
  await settle();
  assert.equal(h.delivered.filter(row => row.text === 'Database issue').length, 1);
  assert.equal(h.delivered.find(row => row.text === 'We need integration').segmentId, interim.segmentId);
  assert.equal(h.delivered.filter(row => row.final).length, 2);
  h.capture.dispose(true);
});

test('stop drains asynchronously delivered final words instead of discarding them', async () => {
  const h = harness(); h.capture.start();
  h.instances[0].onStopping = () => h.instances[0].result([['A final sentence', true]]);
  assert.equal(await h.capture.stop(), true);
  assert.equal(h.delivered.at(-1).text, 'A final sentence');
  assert.equal(h.capture.pending, 0); h.capture.dispose(true);
});

test('enabling during an announcement resumes recognition exactly once', () => {
  const h = harness(); h.capture.start(true); assert.equal(h.instances.length, 0);
  h.capture.resume(); h.capture.resume(); assert.equal(h.instances.length, 1); h.capture.dispose(true);
});

test('unacknowledged finals survive capture replacement and retry without changing identifiers', async () => {
  const h = harness(); h.capture.start(); h.fail(true);
  h.instances[0].result([['Keep my finalized speech', true]]); await settle();
  assert.equal(h.capture.pending, 1); h.capture.dispose();
  h.fail(false); const restored = new h.Capture(h.options); restored.flush(); await settle();
  assert.equal(restored.pending, 0); assert.equal(h.delivered[0].text, 'Keep my finalized speech');
  assert.equal(h.store.size, 0); restored.dispose(true);
});

test('mute pause does not duplicate a recognizer while its stop is pending', async () => {
  const h = harness(); h.capture.start(); h.capture.pause(); h.capture.resume(); assert.equal(h.instances.length, 1);
  await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(h.instances.length, 2); h.capture.dispose(true);
});
