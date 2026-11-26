import { expect, test } from '@playwright/test';

test.skip(!process.env.HIVE_AUDIO_LIVE, 'Requires the local API, PostgreSQL and Redis; no production accounts are used.');
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('two independent accounts resolve ringing and receive one authoritative transcription disclosure', async ({ browser }) => {
  test.setTimeout(180000);
  const a = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const b = await browser.newContext({ permissions: ['microphone', 'camera'] });
  try {
    for (const context of [a, b]) await context.addInitScript(() => {
      const state = window as unknown as { audioLog: string[]; recognitionStarts: number; mediaPeers: RTCPeerConnection[]; emitSpeech: (text: string) => void };
      state.audioLog = []; state.recognitionStarts = 0; state.mediaPeers = [];
      const OriginalPeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends OriginalPeer { constructor(configuration?: RTCConfiguration) { super(configuration); state.mediaPeers.push(this); } };
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
        onstart: (() => void) | null = null;
        onresult: ((event: unknown) => void) | null = null;
        result = 0;
        start() { state.recognitionStarts++; state.emitSpeech = text => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }); queueMicrotask(() => this.onstart?.()); }
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
    await expect(pb).toHaveURL(/\/feed/, { timeout: 60000 });
    await pa.getByRole('button', { name: 'Start a huddle', exact: true }).click();
    await pa.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(pa.getByRole('button', { name: 'Start a huddle', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(pb.getByRole('alertdialog', { name: 'Incoming huddle' })).toHaveCount(0);
    await pa.getByRole('button', { name: 'Start a huddle', exact: true }).click();
    await pa.getByRole('button', { name: 'Join huddle', exact: true }).click();
    await expect(pb.getByRole('alertdialog', { name: 'Incoming huddle' })).toBeVisible();
    await expect.poll(() => pb.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog.includes('start:invitation.wav'))).toBe(true);
    await pa.keyboard.press('Escape');
    await pa.getByRole('link', { name: 'Feed', exact: true }).first().click();
    await expect(pa).toHaveURL(/\/feed/, { timeout: 60000 });
    await expect(pb.getByRole('alertdialog', { name: 'Incoming huddle' })).toBeVisible();
    await pb.getByRole('button', { name: 'Join', exact: true }).click();
    await pb.getByRole('button', { name: 'Join huddle', exact: true }).click();
    await pa.getByRole('button', { name: 'Open the huddle window', exact: true }).first().click();
    await expect(pa.getByText('2 people', { exact: true })).toBeVisible();
    await expect.poll(() => pb.locator('audio').evaluateAll(nodes => nodes.some(node => { const stream = (node as HTMLAudioElement).srcObject; return stream instanceof MediaStream && stream.getAudioTracks().some(track => track.readyState === 'live'); }))).toBe(true);
    const ringsBefore = await pb.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog.filter(event => event === 'start:invitation.wav').length);
    await pb.getByRole('link', { name: 'Feed', exact: true }).first().click();
    await expect(pb).toHaveURL(/\/feed/, { timeout: 60000 });
    await expect.poll(() => pb.locator('audio').evaluateAll(nodes => nodes.some(node => { const stream = (node as HTMLAudioElement).srcObject; return stream instanceof MediaStream && stream.getAudioTracks().some(track => track.readyState === 'live'); }))).toBe(true);
    await pa.getByRole('button', { name: 'Start microphone transcription', exact: true }).click();
    await pa.getByRole('button', { name: 'Enable transcription', exact: true }).click();
    for (const [index, page] of [pa, pb].entries()) {
      await expect.poll(() => page.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog.filter(event => event === 'start:transcription_started.wav').length), { timeout: 45000, message: `Participant ${index + 1} must hear one transcription disclosure` }).toBe(1);
      await expect(page.getByText('Speech transcription is active.', { exact: false }).first()).toBeVisible();
    }
    await expect.poll(() => pa.evaluate(() => (window as unknown as { recognitionStarts: number }).recognitionStarts), { timeout: 20000 }).toBeGreaterThan(0);
    await pb.getByRole('button', { name: 'Open the huddle window', exact: true }).first().click();
    await pb.getByRole('button', { name: 'Start microphone transcription', exact: true }).click();
    await pb.getByRole('button', { name: 'Enable transcription', exact: true }).click();
    await expect.poll(() => pb.evaluate(() => (window as unknown as { recognitionStarts: number }).recognitionStarts)).toBeGreaterThan(0);
    await pa.evaluate(() => (window as unknown as { emitSpeech: (text: string) => void }).emitSpeech('I will finish the backend integration.'));
    await pb.evaluate(() => (window as unknown as { emitSpeech: (text: string) => void }).emitSpeech('I will investigate the database before tomorrow.'));
    for (const page of [pa, pb]) {
      await page.getByRole('tab', { name: 'Notes', exact: true }).click();
      await expect(page.getByText('I will finish the backend integration.', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('I will investigate the database before tomorrow.', { exact: true }).first()).toBeVisible();
    }
    const receivedBytes = () => pb.evaluate(async () => {
      let bytes = 0;
      for (const peer of (window as unknown as { mediaPeers: RTCPeerConnection[] }).mediaPeers) (await peer.getStats()).forEach(report => { if (report.type === 'inbound-rtp' && report.kind === 'audio') bytes += report.bytesReceived; });
      return bytes;
    });
    await expect.poll(receivedBytes).toBeGreaterThan(0);
    const beforeNavigation = await receivedBytes();
    const peerCount = await pb.evaluate(() => (window as unknown as { mediaPeers: RTCPeerConnection[] }).mediaPeers.length);
    await pb.keyboard.press('Escape');
    for (const destination of ['Explore', 'Feed', 'Explore', 'Feed']) await pb.getByRole('link', { name: destination, exact: true }).first().click();
    await expect.poll(receivedBytes).toBeGreaterThan(beforeNavigation);
    expect(await pb.evaluate(() => (window as unknown as { mediaPeers: RTCPeerConnection[] }).mediaPeers.length)).toBe(peerCount);
    expect(await pb.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog.filter(event => event === 'start:invitation.wav').length)).toBe(ringsBefore);
    await pa.keyboard.press('Escape');
    await pa.getByRole('button', { name: 'Open the huddle window', exact: true }).first().click();
    expect(await pa.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog.filter(event => event === 'start:transcription_started.wav').length)).toBe(1);
    expect(await pb.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog.some(event => /recording_started|notes_enabled/.test(event)))).toBe(false);
  } catch (error) {
    for (const [index, context] of [a, b].entries()) for (const page of context.pages()) {
      console.log('Huddle diagnostic', index, await page.evaluate(() => ({ audio: (window as unknown as { audioLog: string[] }).audioLog, status: [...document.querySelectorAll('[role="status"], [role="alert"]')].map(node => node.textContent), peers: (window as unknown as { mediaPeers: RTCPeerConnection[] }).mediaPeers.map(peer => ({ signaling: peer.signalingState, connection: peer.connectionState, ice: peer.iceConnectionState })) })));
    }
    throw error;
  } finally { await a.close(); await b.close(); }
});
