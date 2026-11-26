from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from app.calls import invitations
from app.db.models import HuddleInvitation, HuddleSegment, Notification
from app.db.session import SessionLocal
from tests.helpers import call, connected


async def test_invitation_snapshot_recovers_and_acceptance_reserves_one_device(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, _ = setup_chat
    dm = (await client.post('/api/dms', headers=ah, json={'usernames': ['bob']})).json()['id']
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _), connected(live_server, bob) as (other, _):
        invitation = await call(a, 'call:ring', {'channelId': dm})
        recovered = (await client.get('/api/calls/invitations', headers=bh)).json()
        assert recovered[0]['invitationId'] == invitation['invitationId']
        assert recovered[0]['status'] == 'ringing'
        await call(b, 'call:respond', {'invitationId': invitation['invitationId'], 'action': 'accepted'})
        rejected = await call(other, 'call:respond', {'invitationId': invitation['invitationId'], 'action': 'accepted'})
        assert not rejected['ok']
        await call(a, 'call:join', {'channelId': dm})
        joined = await call(b, 'call:join', {'channelId': dm, 'invitationId': invitation['invitationId']})
        assert joined['ok']
        assert (await invitations.get(invitation['invitationId']))['status'] == 'connecting'
        await call(a, 'call:media-ready', {'channelId': dm, 'peerUserId': bob['user']['id']})
        assert (await invitations.get(invitation['invitationId']))['status'] == 'connecting'
        await call(b, 'call:media-ready', {'channelId': dm, 'peerUserId': alice['user']['id']})
        assert (await invitations.get(invitation['invitationId']))['status'] == 'connected'
        await call(b, 'call:leave', {'channelId': dm})
        assert (await invitations.get(invitation['invitationId']))['status'] == 'ended'


async def test_expiration_creates_one_durable_missed_notification(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, _ = setup_chat
    dm = (await client.post('/api/dms', headers=ah, json={'usernames': ['bob']})).json()['id']
    async with connected(live_server, alice) as (a, _):
        invitation = await call(a, 'call:ring', {'channelId': dm})
        async with SessionLocal() as db:
            row = await db.get(HuddleInvitation, invitation['invitationId'])
            row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
            await db.commit()
        for _ in range(2):
            await invitations.expire_or_cancel()
        async with SessionLocal() as db:
            rows = list(await db.scalars(select(Notification).where(Notification.source_call_id == invitation['invitationId'])))
            assert len(rows) == 1 and rows[0].user_id == bob['user']['id'] and rows[0].type == 'missed_huddle'
        assert (await client.get('/api/calls/invitations', headers=bh)).json() == []
        assert (await client.get('/api/calls/invitations?history=true', headers=bh)).json()[0]['status'] == 'expired'


async def test_transcript_snapshot_is_participant_only_canonical_and_replay_safe(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _):
        joined = await call(a, 'call:join', {'channelId': channel})
        meeting = joined['sessionId']
        assert (await client.get(f'/api/calls/sessions/{meeting}/transcript', headers=bh)).status_code == 403
        assert (await call(b, 'call:join', {'channelId': channel}))['sessionId'] == meeting
        for sock, speaker, text in [(a, alice, 'Backend integration'), (b, bob, 'Database investigation')]:
            await call(sock, 'call:state', {'channelId': channel, 'captions': True})
            segment = {'channelId': channel, 'sessionId': meeting, 'segmentId': 'one', 'sequence': 1, 'revision': 2, 'text': text, 'final': True, 'userId': 'forged'}
            # Speaker identity is always taken from the authenticated socket.
            segment.pop('userId')
            first = await call(sock, 'call:caption', segment)
            assert first['segment']['userId'] == speaker['user']['id']
            repeated = await call(sock, 'call:caption', {**segment, 'text': 'Do not overwrite finalized speech'})
            assert repeated['segment']['text'] == text
        snapshot = (await client.get(f'/api/calls/sessions/{meeting}/transcript', headers=ah)).json()
        assert {row['userId'] for row in snapshot['segments']} == {alice['user']['id'], bob['user']['id']}
        assert all(row['sessionId'] == meeting and row['final'] for row in snapshot['segments'])
        async with SessionLocal() as db:
            assert await db.scalar(select(func.count()).select_from(HuddleSegment).where(HuddleSegment.session_id == meeting)) == 2


async def test_stopping_capture_drains_async_finals_but_not_new_interims(client, setup_chat, live_server):
    alice, _, _, _, _, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _):
        meeting = (await call(a, 'call:join', {'channelId': channel}))['sessionId']
        await call(a, 'call:state', {'channelId': channel, 'captions': True})
        await call(a, 'call:capture-state', {'channelId': channel, 'sessionId': meeting, 'state': 'draining'})
        await call(a, 'call:state', {'channelId': channel, 'captions': False})
        data = {'channelId': channel, 'sessionId': meeting, 'segmentId': 'tail', 'sequence': 2, 'revision': 1, 'text': 'Pending final sentence', 'final': True}
        assert (await call(a, 'call:caption', data))['ok']
        assert not (await call(a, 'call:caption', {**data, 'segmentId': 'late_interim', 'final': False}))['ok']


async def test_disconnect_and_rejoin_preserve_meeting_identity(client, setup_chat, live_server):
    alice, _, _, _, _, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _):
        first = await call(a, 'call:join', {'channelId': channel})
    async with connected(live_server, alice) as (a, _):
        recovered = await call(a, 'call:join', {'channelId': channel})
        assert recovered['sessionId'] == first['sessionId']
        assert recovered['startedAt'] == first['startedAt']
        await call(a, 'call:leave', {'channelId': channel})
        fresh = await call(a, 'call:join', {'channelId': channel})
        assert fresh['sessionId'] != first['sessionId']
