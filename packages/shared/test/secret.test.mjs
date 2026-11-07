import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptMessage, encryptMessage, exportPublicKey, generateDeviceKeys, safetyNumber } from '../dist/secret.js';

async function device(id) {
  const pair = await generateDeviceKeys();
  return { id, pair, publicKey: await exportPublicKey(pair.publicKey) };
}

test('devices read what was encrypted for them and nobody else can', async () => {
  const [a1, a2, b1, eve] = await Promise.all(['a1', 'a2', 'b1', 'eve'].map(device));
  const box = await encryptMessage({
    channelId: 'chan', text: 'meet at 9 ☕', senderDeviceId: 'a1', senderPrivateKey: a1.pair.privateKey,
    targets: [a1, a2, b1].map(d => ({ id: d.id, publicKey: d.publicKey })),
  });
  assert.equal(box.envelopes.length, 3);
  assert.ok(!JSON.stringify(box).includes('meet at 9'));
  for (const reader of [a1, a2, b1]) {
    const text = await decryptMessage({ channelId: 'chan', box, myDeviceId: reader.id, myPrivateKey: reader.pair.privateKey, senderPublicKey: a1.publicKey });
    assert.equal(text, 'meet at 9 ☕');
  }
  // A device without an envelope (e.g. added later) gets nothing.
  assert.equal(await decryptMessage({ channelId: 'chan', box, myDeviceId: 'eve', myPrivateKey: eve.pair.privateKey, senderPublicKey: a1.publicKey }), null);
  // Wrong channel, wrong sender key and tampering all fail.
  const read = (changes) => decryptMessage({ channelId: 'chan', box, myDeviceId: 'b1', myPrivateKey: b1.pair.privateKey, senderPublicKey: a1.publicKey, ...changes });
  assert.equal(await read({ channelId: 'other' }), null);
  assert.equal(await read({ senderPublicKey: eve.publicKey }), null);
  const tampered = structuredClone(box);
  tampered.envelopes[2].ct = tampered.envelopes[2].ct.slice(0, -2) + 'AA';
  assert.equal(await read({ box: tampered }), null);
});

test('the private key cannot be exported and each message uses a fresh salt', async () => {
  const d = await device('d');
  await assert.rejects(crypto.subtle.exportKey('jwk', d.pair.privateKey));
  const options = { channelId: 'c', text: 'same', senderDeviceId: 'd', senderPrivateKey: d.pair.privateKey, targets: [{ id: 'd', publicKey: d.publicKey }] };
  const [one, two] = [await encryptMessage(options), await encryptMessage(options)];
  assert.notEqual(one.salt, two.salt);
  assert.notEqual(one.envelopes[0].ct, two.envelopes[0].ct);
});

test('safety numbers match on both sides and change with the keys', async () => {
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(device));
  const first = await safetyNumber([a.publicKey, b.publicKey]);
  assert.match(first, /^(\d{5} ){5}\d{5}$/);
  assert.equal(first, await safetyNumber([b.publicKey, a.publicKey]));
  assert.notEqual(first, await safetyNumber([a.publicKey, b.publicKey, c.publicKey]));
});
