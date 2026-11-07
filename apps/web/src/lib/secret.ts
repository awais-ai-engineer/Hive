'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { decryptMessage, encryptMessage, exportPublicKey, generateDeviceKeys, safetyNumber, type CiphertextBox, type Message } from '@hive/shared';
import { apiData, requestError } from './spaces';

/**
 * Secret conversations. This browser keeps one key pair per account in IndexedDB; the private
 * key is stored as a non-extractable CryptoKey, so even this site's own code cannot read it out.
 */
type LocalDevice = { deviceId: string; privateKey: CryptoKey; publicKey: string };
type Registered = { id: string; publicKey: string };
export type PersonDevices = { userId: string; username: string; devices: Registered[] };

const DB = 'hive-secret';
const STORE = 'keys';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readRecord(userId: string): Promise<{ privateKey: CryptoKey; publicKey: string } | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(userId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeRecord(userId: string, value: { privateKey: CryptoKey; publicKey: string }) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, userId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function deviceLabel() {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  const system = /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Mac/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : '';
  return `${browser}${system ? ` on ${system}` : ''}`;
}

/** This browser's key pair for the account (created on first use) registered with the server. */
export async function ensureDevice(userId: string): Promise<LocalDevice> {
  if (!window.isSecureContext || !crypto?.subtle || !window.indexedDB) {
    throw new Error('Secret conversations need a modern browser on a secure (https) connection.');
  }
  let record = await readRecord(userId);
  if (!record) {
    const pair = await generateDeviceKeys();
    record = { privateKey: pair.privateKey, publicKey: await exportPublicKey(pair.publicKey) };
    await writeRecord(userId, record);
  }
  const registered = await apiData<Registered>('/api/me/devices', { method: 'PUT', body: JSON.stringify({ publicKey: record.publicKey, label: deviceLabel() }) });
  return { deviceId: registered.id, ...record };
}

export function useSecretChat(userId: string | undefined, channelId: string, enabled: boolean) {
  const [device, setDevice] = useState<LocalDevice | null>(null);
  const [people, setPeople] = useState<PersonDevices[]>([]);
  const [error, setError] = useState('');
  const [safety, setSafety] = useState('');
  const peopleRef = useRef<PersonDevices[]>([]);

  const refresh = useCallback(async () => {
    const list = await apiData<PersonDevices[]>(`/api/dms/${channelId}/devices`);
    peopleRef.current = list; setPeople(list);
    setSafety(await safetyNumber(list.flatMap(person => person.devices.map(item => item.publicKey))));
    return list;
  }, [channelId]);

  useEffect(() => {
    if (!enabled || !userId) return;
    let active = true;
    setDevice(null); setError('');
    ensureDevice(userId).then(async local => { if (!active) return; setDevice(local); await refresh(); })
      .catch(cause => { if (active) setError(requestError(cause)); });
    return () => { active = false; };
  }, [enabled, userId, refresh]);

  const other = people.find(person => person.userId !== userId);
  const peerReady = !!other && other.devices.length > 0;

  /** The ciphertext for everyone's devices, ready to send. */
  const encrypt = useCallback(async (text: string): Promise<CiphertextBox> => {
    if (!device) throw new Error('Your secure keys are still loading. Try again in a moment.');
    const fresh = await refresh();
    if (!fresh.some(person => person.userId !== userId && person.devices.length)) {
      throw new Error('They have not turned on secret conversations yet. They need to open Hive once.');
    }
    return encryptMessage({
      channelId, text, senderDeviceId: device.deviceId, senderPrivateKey: device.privateKey,
      targets: fresh.flatMap(person => person.devices),
    });
  }, [device, refresh, channelId, userId]);

  /** The text of a received message, or null when this device cannot read it. */
  const decrypt = useCallback(async (message: Message): Promise<string | null> => {
    const box = message.ciphertext;
    if (!device || !box) return null;
    const find = (list: PersonDevices[]) => list.flatMap(person => person.devices).find(item => item.id === box.senderDeviceId);
    let sender = find(peopleRef.current);
    if (!sender) sender = find(await refresh());
    if (!sender) return null;
    return decryptMessage({ channelId, box, myDeviceId: device.deviceId, myPrivateKey: device.privateKey, senderPublicKey: sender.publicKey });
  }, [device, refresh, channelId]);

  return { ready: !!device, error, safety, other, peerReady, encrypt, decrypt };
}

export type DeviceRow = { id: string; publicKey: string; label: string; createdAt: string };
