/**
 * End-to-end encryption for secret conversations, built on WebCrypto only.
 *
 * Every device owns an ECDH P-256 key pair. A message is encrypted separately for each target
 * device: the AES-GCM key comes from ECDH(sender device, target device) run through HKDF, with a
 * per-message random salt, and the channel and both device ids are bound into the key and the
 * authenticated data. The server only ever sees the resulting envelopes.
 */

export type Envelope = { deviceId: string; iv: string; ct: string };
export type CiphertextBox = { v: 1; senderDeviceId: string; salt: string; envelopes: Envelope[] };
export type DeviceKey = { id: string; publicKey: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toB64u(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const text = atob(padded);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}

/** A fresh device key pair; the private key cannot be exported. */
export async function generateDeviceKeys(): Promise<CryptoKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  // Re-import the private half as non-extractable; the extractable original is dropped here.
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { publicKey: pair.publicKey, privateKey };
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toB64u(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

async function importPublicKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromB64u(value) as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

function context(channelId: string, senderDeviceId: string, recipientDeviceId: string) {
  return encoder.encode(`hive-secret-v1|${channelId}|${senderDeviceId}|${recipientDeviceId}`);
}

async function messageKey(privateKey: CryptoKey, peerPublicKey: string, salt: Uint8Array, info: Uint8Array) {
  const peer = await importPublicKey(peerPublicKey);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** Encrypt `text` for every target device (include the sender's own devices so it can reread it). */
export async function encryptMessage(opts: {
  channelId: string; text: string; senderDeviceId: string; senderPrivateKey: CryptoKey; targets: DeviceKey[];
}): Promise<CiphertextBox> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const envelopes: Envelope[] = [];
  for (const target of opts.targets) {
    const info = context(opts.channelId, opts.senderDeviceId, target.id);
    const key = await messageKey(opts.senderPrivateKey, target.publicKey, salt, info);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: info as BufferSource }, key, encoder.encode(opts.text));
    envelopes.push({ deviceId: target.id, iv: toB64u(iv), ct: toB64u(new Uint8Array(sealed)) });
  }
  return { v: 1, senderDeviceId: opts.senderDeviceId, salt: toB64u(salt), envelopes };
}

/** The text, or null when this device has no envelope or the message was tampered with. */
export async function decryptMessage(opts: {
  channelId: string; box: CiphertextBox; myDeviceId: string; myPrivateKey: CryptoKey; senderPublicKey: string;
}): Promise<string | null> {
  const envelope = opts.box.envelopes.find(item => item.deviceId === opts.myDeviceId);
  if (!envelope) return null;
  try {
    const info = context(opts.channelId, opts.box.senderDeviceId, opts.myDeviceId);
    const key = await messageKey(opts.myPrivateKey, opts.senderPublicKey, fromB64u(opts.box.salt), info);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64u(envelope.iv) as BufferSource, additionalData: info as BufferSource },
      key, fromB64u(envelope.ct) as BufferSource);
    return decoder.decode(plain);
  } catch {
    return null;
  }
}

/**
 * A number both people can read out to each other. It is the same on both sides because it
 * covers every device key of the conversation in a fixed order; it changes when a device is added.
 */
export async function safetyNumber(publicKeys: string[]): Promise<string> {
  const joined = encoder.encode([...publicKeys].sort().join('|'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', joined));
  const groups: string[] = [];
  for (let index = 0; index < 30; index += 5) {
    let value = 0;
    for (let byte = 0; byte < 5; byte++) value = value * 256 + digest[index + byte];
    groups.push(String(value % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}
