import { expect, test } from '@playwright/test';

test.skip(!process.env.HIVE_AUDIO_LIVE, 'Requires the local API, PostgreSQL and Redis; no production accounts are used.');
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('two independent accounts resolve ringing and receive one authoritative transcription disclosure', async ({ browser }) => {
  test.setTimeout(180000);
  const a = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const b = await browser.newContext({ permissions: ['microphone', 'camera'] });
  try {
    for (const context of [a, b]) await context.addInitScript(() => {
      const state = window as unknown as { audioLog: string[]; recognitionStarts: number };
      state.audioLog = []; state.recognitionStarts = 0;
      const byteNames = new WeakMap<ArrayBuffer, string>(); const bufferNames = new WeakMap<AudioBuffer, string>();
      const fetcher = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await fetcher(...args);
        if (String(args[0]).includes('/sounds/v2/')) {
          const read = response.arrayBuffer.bind(response);
          response.arrayBuffer = async () => { const bytes = await read(); byteNames.set(bytes, String(args[0]).split('/').pop()!); return bytes; };
        }
        return response;
      };
      const decode = AudioContext.prototype.decodeAudioData;
      AudioContext.prototype.decodeAudioData = function (bytes: ArrayBuffer) {
        const name = byteNames.get(bytes); return decode.call(this, bytes).then(buffer => { if (name) bufferNames.set(buffer, name); return buffer; });
      };
      const create = AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource = function () {
        const source = create.call(this); const start = source.start.bind(source); const stop = source.stop.bind(source);
        source.start = (...args: Parameters<typeof source.start>) => { state.audioLog.push(`start:${bufferNames.get(source.buffer!)}`); start(...args); };
        source.stop = (...args: Parameters<typeof source.stop>) => { state.audioLog.push(`stop:${bufferNames.get(source.buffer!)}`); stop(...args); };
        return source;
      };
      class Recognition {
        onend: (() => void) | null = null;
        start() { state.recognitionStarts++; }
        stop() { queueMicrotask(() => this.onend?.()); }
      }
      Object.assign(window, { SpeechRecognition: Recognition, webkitSpeechRecognition: Recognition });
    });
    const suffix = Date.now().toString(36); const password = 'audio-test-password123';
    const first = await a.request.post('http://localhost:4000/api/auth/signup', { data: { username: `audioa${suffix}`, email: `audioa${suffix}@hive.test`, password } });
    const second = await b.request.post('http://localhost:4000/api/auth/signup', { data: { username: `audiob${suffix}`, email: `audiob${suffix}@hive.test`, password } });
    expect(first.status()).toBe(201); expect(second.status()).toBe(201);
    const account = await first.json(); const other = await second.json();
    const slug = `audio-${suffix}`;
    expect((await a.request.post('http://localhost:4000/api/spaces', { headers: { Authorization: `Bearer ${account.access_token}` }, data: { type: 'community', name: 'Audio verification', slug } })).status()).toBe(201);
    expect((await b.request.post(`http://localhost:4000/api/spaces/${slug}/join`, { headers: { Authorization: `Bearer ${other.access_token}` } })).status()).toBe(200);
    const dm = await a.request.post('http://localhost:4000/api/dms', { headers: { Authorization: `Bearer ${account.access_token}` }, data: { usernames: [other.user.username] } });
    expect(dm.status()).toBe(200);
    const channel = (await dm.json()).id;
    const pa = await a.newPage(); const pb = await b.newPage();
    await pa.goto(`http://localhost:3000/home?c=${channel}`); await pb.goto(`http://localhost:3000/home?c=${channel}`);
    await pb.getByRole('heading', { name: account.user.username, exact: true }).click();
    await pb.getByRole('link', { name: 'Feed', exact: true }).first().click();
    await expect(pb).toHaveURL(/\/feed/);
    await pa.getByRole('button', { name: 'Start a huddle', exact: true }).click();
    await pa.getByRole('button', { name: 'Join huddle', exact: true }).click();
    await expect(pb.getByRole('alertdialog', { name: 'Incoming huddle' })).toBeVisible();
    await expect.poll(() => pb.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog.includes('start:invitation.wav'))).toBe(true);
    await pb.getByRole('button', { name: 'Join', exact: true }).click();
    await pb.getByRole('button', { name: 'Join huddle', exact: true }).click();
    await expect(pa.getByText('2 people', { exact: true })).toBeVisible();
    await expect.poll(() => pb.locator('audio').evaluateAll(nodes => nodes.some(node => { const stream = (node as HTMLAudioElement).srcObject; return stream instanceof MediaStream && stream.getAudioTracks().some(track => track.readyState === 'live'); }))).toBe(true);
    await expect.poll(() => pb.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog.includes('stop:invitation.wav'))).toBe(true);
    await pb.getByRole('link', { name: 'Feed', exact: true }).first().click();
    await expect(pb).toHaveURL(/\/feed/);
    await expect.poll(() => pb.locator('audio').evaluateAll(nodes => nodes.some(node => { const stream = (node as HTMLAudioElement).srcObject; return stream instanceof MediaStream && stream.getAudioTracks().some(track => track.readyState === 'live'); }))).toBe(true);
    await pa.getByRole('button', { name: 'Turn captions on', exact: true }).click();
    await pa.getByRole('button', { name: 'Enable transcription', exact: true }).click();
    for (const page of [pa, pb]) {
      await expect.poll(() => page.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog.filter(event => event === 'start:transcription_started.wav').length), { timeout: 20000 }).toBe(1);
      await expect(page.getByText('Speech transcription is active. Finalized captions are saved as meeting notes.', { exact: true }).first()).toBeVisible();
    }
    await expect.poll(() => pa.evaluate(() => (window as unknown as { recognitionStarts: number }).recognitionStarts), { timeout: 20000 }).toBeGreaterThan(0);
    await pa.keyboard.press('Escape');
    await pa.getByRole('button', { name: 'Open the huddle window', exact: true }).first().click();
    expect(await pa.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog.filter(event => event === 'start:transcription_started.wav').length)).toBe(1);
    expect(await pb.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog.some(event => /recording_started|notes_enabled/.test(event)))).toBe(false);
  } finally { await a.close(); await b.close(); }
});
