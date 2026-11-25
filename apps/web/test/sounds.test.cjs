const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const shared = require('../../../packages/shared/dist/sounds.js');
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/sounds.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(locked = false, sharedStorage = new Map()) {
  const played = [], stopped = [], intervals = new Map(), timeouts = new Map(), storage = sharedStorage;
  let tick = 10000, missing = false;
  class Context {
    state = 'running'; currentTime = 0; destination = {};
    resume() { return Promise.resolve(); }
    decodeAudioData(bytes) { return Promise.resolve({ name: bytes }); }
    createGain() { return { gain: { value: 0, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
    createBufferSource() {
      return { connect() { return { connect() {} }; }, disconnect() {}, start() { played.push(this); }, stop() { stopped.push(this); } };
    }
  }
  const sandbox = { exports: {}, require: name => name === '@hive/shared' ? shared : { currentUserId: () => 'test-user' },
    window: { AudioContext: Context, addEventListener() {} }, navigator: { locks: { request: async (_, fn) => fn() } }, document: { hidden: false },
    crypto: { randomUUID: () => 'uuid' }, Date: class extends Date { static now() { return tick; } },
    setTimeout: fn => { const id = timeouts.size + 1; timeouts.set(id, fn); return id; }, clearTimeout: id => timeouts.delete(id),
    setInterval: fn => { const id = intervals.size + 1; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    fetch: async url => ({ ok: !missing, arrayBuffer: async () => url.split('/').pop() }),
  };
  vm.runInNewContext(source, sandbox);
  const manager = sandbox.exports;
  manager.suppressSounds(false); if (!locked) manager.unlockSounds();
  return { manager, played, stopped, intervals, timeouts, advance: n => tick += n, missing: () => { missing = true; }, finish: () => played.at(-1)?.onended?.() };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('every event has its own bundled WAV, and PCM assets have unique contents', () => {
  const hashes = new Set();
  for (const event of Object.keys(shared.soundEvents)) {
    const file = fs.readFileSync(path.join(__dirname, '../public/sounds/v2', `${event}.wav`));
    assert.equal(file.toString('ascii', 0, 4), 'RIFF');
    const hash = require('node:crypto').createHash('sha256').update(file).digest('hex');
    assert.ok(!hashes.has(hash), `duplicate ${event}`); hashes.add(hash);
    assert.ok(file.length < 350000, `${event} exceeds asset budget`);
  }
});
test('older account switches map to new categories', () => {
  const value = shared.normalizeSoundPreferences({ messages: false, huddles: false });
  assert.equal(value.mentions, false); assert.equal(value.controls, false); assert.equal(value.participants, false);
  assert.equal(value.announcements, true);
});
test('deduplicates events even while the buffer is loading', async () => {
  const h = harness(); h.manager.playSound('incoming', undefined, 'message:1'); h.manager.playSound('incoming', undefined, 'message:1');
  await settle(); assert.equal(h.played.length, 1);
});
test('sent, incoming and control sounds use different files', async () => {
  const h = harness();
  for (const event of ['incoming', 'message_sent', 'microphone_mute', 'microphone_on', 'screen_on', 'screen_off']) {
    h.advance(1000); h.manager.playSound(event); await settle(); h.finish();
  }
  assert.equal(new Set(h.played.map(node => node.buffer.name)).size, 6);
});
test('resolved ringtone cancels playback, timer and in-flight buffer', async () => {
  const h = harness(); h.manager.startRing('call'); h.manager.stopRing('call'); await settle();
  assert.equal(h.played.length, 0); assert.equal(h.intervals.size, 0);
  h.manager.startRing('next'); await settle(); assert.equal(h.played.length, 1);
  h.manager.stopRing('next'); assert.equal(h.stopped.length, 1); assert.equal(h.intervals.size, 0);
});
test('old invitation resolution cannot stop a newer ringtone', async () => {
  const h = harness(); h.manager.startRing('old'); h.manager.startRing('new'); await settle();
  h.manager.stopRing('old'); assert.equal(h.intervals.size, 1);
});
test('announcement preempts a call tone and blocks ordinary notifications', async () => {
  const h = harness(); const state = []; h.manager.onAnnouncement(value => state.push(value));
  h.manager.startRing('call'); await settle();
  h.manager.announceSound('transcription_started', 'state:1'); await settle();
  h.advance(1000); h.manager.playSound('incoming', undefined, 'message:1'); await settle();
  assert.equal(h.played.length, 2); assert.equal(h.stopped.length, 1); assert.equal(state.at(-1), true);
  h.finish(); assert.equal(state.at(-1), false);
});
test('quiet mode and disabled events silence optional cues but preserve mandatory disclosures', async () => {
  const h = harness(); h.manager.suppressSounds(true); h.manager.configureSounds({ enabled: false, volume: 0 });
  h.manager.playSound('incoming'); h.manager.announceSound('transcription_started', 'state:2'); await settle();
  assert.equal(h.played.length, 1); assert.match(h.played[0].buffer.name, /transcription_started/);
});
test('previews do not mutate saved preferences and survive muted categories', async () => {
  const h = harness(); h.manager.configureSounds({ controls: false });
  h.manager.previewSound('microphone_on', .2); await settle();
  assert.equal(h.played.length, 1); assert.equal(h.manager.soundPreferences().controls, false);
});
test('unavailable assets fail silently without unhandled rejections', async () => {
  const h = harness(); h.missing(); h.manager.playSound('screen_on'); await settle(); assert.equal(h.played.length, 0);
});
test('logout cleanup invalidates buffered sounds and removes ringtone timers', async () => {
  const h = harness(); h.manager.startRing('call'); h.manager.resetAudio(); await settle();
  assert.equal(h.played.length, 0); assert.equal(h.intervals.size, 0);
});

test('required disclosure waits for a gesture while ordinary autoplay stays silent', async () => {
  const h = harness(true); h.manager.playSound('incoming'); h.manager.announceSound('transcription_started', 'locked:1'); await settle();
  assert.equal(h.played.length, 0); h.manager.unlockSounds(); await settle();
  assert.equal(h.played.length, 1); assert.match(h.played[0].buffer.name, /transcription_started/);
});
test('distinct required disclosures queue without overlap or repetition', async () => {
  const h = harness(); h.manager.announceSound('transcription_started', 'state:1'); await settle();
  h.manager.announceSound('transcription_stopped', 'state:2'); h.manager.announceSound('transcription_stopped', 'state:2'); await settle();
  assert.equal(h.played.length, 1); h.finish(); await settle(); assert.equal(h.played.length, 2);
  h.finish(); await settle(); assert.equal(h.played.length, 2);
});
test('Huddle teardown cancels queued disclosures and pending loads', async () => {
  const h = harness(); h.manager.announceSound('transcription_started', 'state:1'); await settle();
  h.manager.announceSound('transcription_stopped', 'state:2'); await settle();
  h.manager.stopHuddleAudio(); h.finish(); await settle(); assert.equal(h.played.length, 1);
});
test('exact invitation deadline clears both timers and current ring', async () => {
  const h = harness(); h.manager.startRing('timed', false, 11000); await settle();
  h.advance(1000); [...h.timeouts.values()][0]();
  assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 0); assert.equal(h.stopped.length, 1);
});
test('individual event preference suppresses playback', async () => {
  const h = harness(); h.manager.configureSounds({ events: { camera_on: false } }); h.manager.playSound('camera_on'); await settle(); assert.equal(h.played.length, 0);
});

test('shared storage and the tab lock prevent double playback across browser tabs', async () => {
  const storage = new Map(); const a = harness(false, storage); const b = harness(false, storage);
  a.manager.playSound('incoming', undefined, 'shared:1'); b.manager.playSound('incoming', undefined, 'shared:1'); await settle();
  assert.equal(a.played.length + b.played.length, 1);
});
