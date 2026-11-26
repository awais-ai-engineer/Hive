import io
import wave

import httpx

from app.core.config import settings
from tests.helpers import call, connected


def pcm():
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b'\0\0' * 80000)
    return output.getvalue()


async def test_worker_consent_replay_and_overlap(client, setup_chat, live_server, monkeypatch):
    alice, _, _, ah, bh, _, _, channel = setup_chat
    monkeypatch.setattr(settings, 'transcription_url', 'http://speech.internal')
    monkeypatch.setattr(settings, 'transcription_token', 'unit-test-private-token')
    invocations = []
    original = httpx.AsyncClient.post

    async def post(self, url, **kwargs):
        if str(url) != 'http://speech.internal/transcribe':
            return await original(self, url, **kwargs)
        invocations.append(kwargs)
        return httpx.Response(200, json={'words': [
            {'start': 0, 'end': .5, 'word': ' Hello'}, {'start': 1, 'end': 2, 'word': ' team'},
            {'start': 4.6, 'end': 4.9, 'word': ' tomorrow'}]}, request=httpx.Request('POST', url))
    monkeypatch.setattr(httpx.AsyncClient, 'post', post)
    async with connected(live_server, alice) as (a, _):
        meeting = (await call(a, 'call:join', {'channelId': channel}))['sessionId']
        path = f'/api/calls/sessions/{meeting}/audio'
        data = {'channel_id': channel, 'sid': a.get_sid(), 'run_id': 'capture', 'chunk_id': 'one', 'sequence': 1,
                'start_ms': 0, 'final': 'false', 'language': 'en-US'}
        files = {'audio': ('speech.wav', pcm(), 'audio/wav')}
        assert (await client.post(path, headers=bh, data=data, files=files)).status_code == 403
        assert (await client.post(path, headers=ah, data=data, files=files)).status_code == 403
        await call(a, 'call:state', {'channelId': channel, 'captions': True})
        assert (await client.post(path, headers=ah, data=data,
                                 files={'audio': ('bad.wav', b'bad', 'audio/wav')})).status_code == 422
        first = await client.post(path, headers=ah, data=data, files=files)
        assert first.status_code == 200
        assert first.json()['segment']['text'] == 'Hello team'
        repeated = await client.post(path, headers=ah, data=data, files=files)
        assert repeated.json()['segment']['segmentId'] == first.json()['segment']['segmentId']
        assert repeated.json()['segment']['text'] == first.json()['segment']['text'] and len(invocations) == 1
        second = await client.post(path, headers=ah, data={**data, 'chunk_id': 'two', 'sequence': 2,
                                                         'start_ms': 4000, 'final': 'true'}, files=files)
        assert second.status_code == 200
        assert second.json()['segment']['text'] == 'team tomorrow'
        assert len(invocations) == 2
        assert invocations[0]['headers']['Authorization'] == 'Bearer unit-test-private-token'
        assert 'transcription_token' not in (await client.get('/api/calls/transcription', headers=ah)).json()
