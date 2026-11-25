from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.db.models import Attachment
from app.db.session import SessionLocal
from tests.helpers import call, connected, event, quiet


def schedule(**patch):
    now = datetime.now(UTC)
    return {"status": "in_a_meeting", "starts_at": (now - timedelta(minutes=1)).isoformat(),
            "ends_at": (now + timedelta(hours=1)).isoformat(), "timezone": "Asia/Karachi",
            "restrictions": ["messages", "media", "voice", "huddles"], **patch}


async def test_direct_policy_enforced_rest_and_socket(client, setup_chat, live_server):
    alice, _bob, _, ah, bh, ch, _, channel = setup_chat
    dm = (await client.post('/api/dms', headers=ah, json={"usernames": ["bob"]})).json()['id']
    response = await client.post('/api/me/availability', headers=bh, json=schedule())
    assert response.status_code == 201, response.text
    item = response.json()
    policy = await client.get(f'/api/channels/{dm}/availability', headers=ah)
    assert policy.json()[0]['blocked'] == ['huddles', 'media', 'messages', 'voice']
    assert (await client.get(f'/api/channels/{dm}/availability', headers=ch)).status_code == 404
    assert (await client.post(f'/api/channels/{dm}/uploads', headers=ah,
        files={'file': ('a.txt', b'hello', 'text/plain')})).status_code == 403
    async with connected(live_server, alice) as (a, _):
        denied = await call(a, 'message:send', {'channelId': dm, 'body': 'blocked', 'clientMsgId': str(uuid4())})
        assert not denied['ok'] and 'restricted' in denied['error']['message']
        assert not (await call(a, 'call:ring', {'channelId': dm}))['ok']
        assert not (await call(a, 'call:join', {'channelId': dm}))['ok']
        assert (await call(a, 'message:send', {'channelId': channel, 'body': 'shared channel works', 'clientMsgId': str(uuid4())}))['ok']
        assert (await client.delete(f"/api/me/availability/{item['id']}", headers=ah)).status_code == 404
        assert (await client.delete(f"/api/me/availability/{item['id']}", headers=bh)).status_code == 204
        assert (await call(a, 'message:send', {'channelId': dm, 'body': 'allowed now', 'clientMsgId': str(uuid4())}))['ok']


async def test_schedules_exceptions_overlap_and_sound_preferences(client, setup_chat):
    alice, _, _, ah, bh, _, _, _ = setup_chat
    dm = (await client.post('/api/dms', headers=ah, json={'usernames': ['bob']})).json()['id']
    future = schedule(starts_at=(datetime.now(UTC) + timedelta(minutes=5)).isoformat())
    assert (await client.post('/api/me/availability', headers=bh, json=future)).status_code == 201
    assert (await client.get(f'/api/channels/{dm}/availability', headers=ah)).json()[0]['blocked'] == []
    exempt = schedule(exceptions=[alice['user']['id']])
    assert (await client.post('/api/me/availability', headers=bh, json=exempt)).status_code == 201
    assert (await client.get(f'/api/channels/{dm}/availability', headers=ah)).json()[0]['blocked'] == []
    voice = (await client.post('/api/me/availability', headers=bh, json=schedule(restrictions=['voice']))).json()
    assert (await client.get(f'/api/channels/{dm}/availability', headers=ah)).json()[0]['blocked'] == ['voice']
    assert (await client.put(f"/api/me/availability/{voice['id']}", headers=bh, json=schedule(restrictions=['media']))).status_code == 200
    assert (await client.get(f'/api/channels/{dm}/availability', headers=ah)).json()[0]['blocked'] == ['media']
    assert (await client.post('/api/me/availability', headers=ah, json=schedule(ends_at='2020-01-01T00:00:00Z'))).status_code == 422
    assert (await client.post('/api/me/availability', headers=ah, json=schedule(starts_at='2026-01-01T00:00:00'))).status_code == 422
    sounds = {'enabled': True, 'volume': 0.2, 'messages': False, 'huddles': True, 'activity': False, 'feedback': True}
    assert {key: value for key, value in (await client.put('/api/me/sounds', headers=ah, json=sounds)).json().items() if key in sounds} == sounds
    assert {key: value for key, value in (await client.get('/api/me/sounds', headers=ah)).json().items() if key in sounds} == sounds
    assert (await client.put('/api/me/sounds', headers=ah, json={**sounds, 'volume': 2})).status_code == 422


async def test_caption_consent_idempotency_and_single_device(client, setup_chat, live_server):
    alice, bob, _, _, _, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _), connected(live_server, alice) as (second, _), connected(live_server, bob) as (b, bq):
        for peer in (a, second, b):
            assert (await call(peer, 'call:join', {'channelId': channel}))['ok']
        caption = {'channelId': channel, 'segmentId': 'unique_segment', 'text': 'Ship Friday', 'final': True}
        assert not (await call(a, 'call:caption', caption))['ok']
        assert (await call(a, 'call:state', {'channelId': channel, 'captions': True}))['ok']
        assert not (await call(second, 'call:state', {'channelId': channel, 'captions': True}))['ok']
        assert (await call(a, 'call:caption', caption))['ok']
        received = await event(bq['call:caption'])
        assert received['userId'] == alice['user']['id'] and received['segmentId'] == 'unique_segment'
        assert received['timestamp']
        assert (await call(a, 'call:caption', caption))['ok']
        await quiet(bq['call:caption'])
        assert (await call(a, 'call:state', {'channelId': channel, 'muted': True}))['ok']
        assert not (await call(a, 'call:caption', {**caption, 'segmentId': 'muted'}))['ok']


async def test_upload_sign_failure_rolls_back_attachment(client, setup_chat, monkeypatch):
    from unittest.mock import AsyncMock

    from app.storage import get_storage

    storage = get_storage()
    monkeypatch.setattr(storage, 'signed_urls', AsyncMock(return_value={}))
    response = await client.post(f'/api/channels/{setup_chat[7]}/uploads', headers=setup_chat[3],
        files={'file': ('test.txt', b'hello', 'text/plain')})
    assert response.status_code == 502
    async with SessionLocal() as session:
        assert await session.scalar(select(Attachment.id)) is None


@pytest.mark.parametrize("count", [2, 3, 5])
async def test_independent_speakers_contribute_notes(client, setup_chat, live_server, count):
    import json
    from contextlib import AsyncExitStack

    from app.calls.service import notes_key
    from app.db.session import redis
    from tests.helpers import create_account

    alice, bob, _, _ah, _, _, _, channel = setup_chat
    accounts = [alice, bob]
    for index in range(count - 2):
        account, _headers = await create_account(client, f"speaker{index}", f"speaker{index}@hive.test")
        await client.post('/api/spaces/chat/join', headers={'Authorization': f"Bearer {account['access_token']}"}, json={})
        accounts.append(account)
    async with AsyncExitStack() as stack:
        sockets = [await stack.enter_async_context(connected(live_server, account)) for account in accounts]
        for index, (peer, _) in enumerate(sockets):
            assert (await call(peer, 'call:join', {'channelId': channel}))['ok']
            assert (await call(peer, 'call:state', {'channelId': channel, 'captions': True}))['ok']
            payload = {'channelId': channel, 'segmentId': f'speaker_{index}', 'text': f'Decision from speaker {index}', 'final': True}
            assert (await call(peer, 'call:caption', payload))['ok']
            assert (await call(peer, 'call:caption', payload))['ok']
        lines = [json.loads(value) for value in await redis.lrange(notes_key(channel), 0, -1)]
        assert len(lines) == count
        assert {line['who'] for line in lines} == {account['user']['username'] for account in accounts}


async def test_expiration_restores_profile_and_media_kind_cannot_bypass_voice_policy(client, setup_chat, live_server):
    from sqlalchemy import update

    from app.db.models import AvailabilitySchedule
    from tests.test_voice import webm

    alice, _, _, ah, bh, _, _, _ = setup_chat
    dm = (await client.post('/api/dms', headers=ah, json={'usernames': ['bob']})).json()['id']
    uploaded = await client.post(f'/api/channels/{dm}/uploads', headers=ah,
        files={'file': ('voice.webm', webm(2), 'audio/webm')})
    assert uploaded.status_code == 201
    item = (await client.post('/api/me/availability', headers=bh, json=schedule(restrictions=['voice']))).json()
    profile = (await client.get('/api/users/bob', headers=ah)).json()
    assert profile['status_text'] == 'In A Meeting'
    async with connected(live_server, alice) as (a, _):
        result = await call(a, 'message:send', {'channelId': dm, 'body': 'audio disguised as a file',
            'attachmentIds': [uploaded.json()['id']], 'clientMsgId': str(uuid4())})
        assert not result['ok']
    async with SessionLocal() as session:
        await session.execute(update(AvailabilitySchedule).where(AvailabilitySchedule.id == item['id']).values(
            starts_at=datetime.now(UTC) - timedelta(hours=2), ends_at=datetime.now(UTC) - timedelta(hours=1)))
        await session.commit()
    assert (await client.get(f'/api/channels/{dm}/availability', headers=ah)).json()[0]['blocked'] == []
    assert (await client.get('/api/users/bob', headers=ah)).json()['status_text'] is None
