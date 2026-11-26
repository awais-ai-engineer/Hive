
from app.calls import invitations
from tests.helpers import call, connected, event, quiet


async def test_disclosure_is_authoritative_aggregate_and_late_join_snapshot(client, setup_chat, live_server):
    alice, bob, carol, _, _, ch, _, channel = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, bq), connected(live_server, carol) as (c, cq):
        await call(a, 'call:join', {'channelId': channel})
        await call(b, 'call:join', {'channelId': channel})
        assert (await call(c, 'call:state', {'channelId': channel, 'captions': True}))['error']['code'] == 'forbidden'
        await quiet(cq['call:disclosure'])
        await call(a, 'call:state', {'channelId': channel, 'captions': True})
        first = await event(aq['call:disclosure'])
        assert first == await event(bq['call:disclosure'])
        assert first['event'] == 'transcription_started'
        await call(a, 'call:state', {'channelId': channel, 'captions': True})
        await call(b, 'call:state', {'channelId': channel, 'captions': True})
        await quiet(aq['call:disclosure'])
        joined = await call(c, 'call:join', {'channelId': channel})
        assert joined['transcription']['active'] is True
        await call(a, 'call:state', {'channelId': channel, 'captions': False})
        await quiet(bq['call:disclosure'])
        await call(b, 'call:state', {'channelId': channel, 'captions': False})
        stopped = await event(cq['call:disclosure'])
        assert stopped['event'] == 'transcription_stopped' and stopped['id'] != first['id']


async def test_invitation_decline_reaches_caller_and_all_recipient_devices(client, setup_chat, live_server):
    alice, bob, carol, ah, _, _, _, _ = setup_chat
    dm = (await client.post('/api/dms', headers=ah, json={'usernames': ['bob']})).json()['id']
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, bq), connected(live_server, bob) as (_, second), connected(live_server, carol) as (c, _):
        row = await call(a, 'call:ring', {'channelId': dm})
        incoming = await event(bq['call:incoming'])
        assert incoming['invitationId'] == (await event(second['call:incoming']))['invitationId']
        assert incoming['invitationId'] == row['invitationId']
        assert (await call(c, 'call:respond', {'invitationId': row['invitationId'], 'action': 'declined'}))['error']['code'] == 'forbidden'
        assert incoming['status'] == 'ringing' and incoming['from']['displayName'] == 'alice'
        await call(b, 'call:respond', {'invitationId': row['invitationId'], 'action': 'declined'})
        assert (await event(aq['call:resolved']))['status'] == 'declined'
        assert (await event(second['call:resolved']))['status'] == 'declined'
        await call(b, 'call:respond', {'invitationId': row['invitationId'], 'action': 'declined'})
        await quiet(aq['call:resolved'])


async def test_invitation_accept_cancel_and_expiry(client, setup_chat, live_server):
    alice, bob, _, ah, _, _, _, _ = setup_chat
    dm = (await client.post('/api/dms', headers=ah, json={'usernames': ['bob']})).json()['id']
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, _bq):
        row = await invitations.create(dm, alice['user']['id'], [bob['user']['id']], a.get_sid())
        await call(b, 'call:join', {'channelId': dm})
        assert (await call(b, 'call:respond', {'invitationId': row['invitationId'], 'action': 'accepted'}))['ok']
        assert (await event(aq['call:resolved']))['status'] == 'accepted'
        row = await invitations.create(dm, alice['user']['id'], [bob['user']['id']], a.get_sid())
        await call(a, 'call:respond', {'invitationId': row['invitationId'], 'action': 'cancelled'})
        assert (await event(aq['call:resolved']))['status'] == 'cancelled'
        row = await invitations.create(dm, alice['user']['id'], [bob['user']['id']], a.get_sid())
        from datetime import UTC, datetime, timedelta

        from app.db.models import HuddleInvitation
        from app.db.session import SessionLocal
        async with SessionLocal() as session:
            expired = await session.get(HuddleInvitation, row['invitationId'])
            expired.expires_at = datetime.now(UTC) - timedelta(seconds=1)
            await session.commit()
        await invitations.expire_or_cancel()
        assert (await event(aq['call:resolved']))['status'] == 'expired'


async def test_sound_preferences_legacy_categories_events_and_sync(client, setup_chat, live_server):
    alice, _, _, ah, bh, _, _, _ = setup_chat
    async with connected(live_server, alice) as (_, aq):
        response = await client.put('/api/me/sounds', headers=ah, json={'huddles': False, 'messages': False, 'events': {'screen_on': False}, 'volume': .2})
        assert response.status_code == 200
        saved = response.json()
        assert saved['controls'] is False and saved['participants'] is False and saved['mentions'] is False
        assert saved['announcements'] is True
        assert (await event(aq['sounds:updated']))['events'] == {'screen_on': False}
        assert (await client.get('/api/me/sounds', headers=ah)).json() == saved
        assert (await client.get('/api/me/sounds', headers=bh)).json()['events'] == {}
        assert (await client.put('/api/me/sounds', headers=ah, json={'volume': 2})).status_code == 422
        assert (await client.get('/api/me/sounds')).status_code == 401


async def test_group_decline_keeps_other_invitation_pending(client, setup_chat, live_server):
    alice, bob, carol, ah, _, ch, _, _ = setup_chat
    await client.post('/api/spaces/chat/join', headers=ch)
    dm = (await client.post('/api/dms', headers=ah, json={'usernames': ['bob', 'carol']})).json()['id']
    async with connected(live_server, alice) as (a, aq), connected(live_server, bob) as (b, bq), connected(live_server, carol) as (c, cq):
        row = await call(a, 'call:ring', {'channelId': dm})
        await call(b, 'call:respond', {'invitationId': row['invitationId'], 'action': 'declined'})
        assert (await event(bq['call:resolved']))['status'] == 'declined'
        await quiet(aq['call:resolved'])
        await call(c, 'call:join', {'channelId': dm})
        assert (await event(aq['call:resolved']))['status'] == 'accepted'
        assert (await event(cq['call:resolved']))['status'] == 'accepted'


async def test_muted_conversation_receives_visual_invitation_without_audio(client, setup_chat, live_server):
    from app.db.models import ConversationPref
    from app.db.session import SessionLocal

    alice, bob, _, ah, _, _, _, _ = setup_chat
    dm = (await client.post('/api/dms', headers=ah, json={'usernames': ['bob']})).json()['id']
    async with SessionLocal() as session:
        session.add(ConversationPref(user_id=bob['user']['id'], channel_id=dm, level='nothing'))
        await session.commit()
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (_, bq):
        assert (await call(a, 'call:ring', {'channelId': dm}))['ok']
        assert (await event(bq['call:incoming']))['sound'] is False
