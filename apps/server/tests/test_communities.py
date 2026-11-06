import asyncio
import json
from pathlib import Path

import pytest
from sqlalchemy import select

from app.db.models import SpaceMember
from app.db.session import SessionLocal
from app.spaces.categories import CATEGORIES
from tests.helpers import call, connected, event, quiet, send


def test_category_catalog():
    entries = json.loads((Path(__file__).resolve().parents[3] / 'packages/shared/src/categories.json').read_text())
    assert tuple(item['slug'] for item in entries) == CATEGORIES


async def test_categories_tags_and_permissions(client, setup_chat):
    ah, bh, ch = setup_chat[3:6]
    response = await client.post('/api/spaces', headers=ah, json={'name': 'Music', 'slug': 'music', 'type': 'community', 'category': 'music', 'tags': [' Jazz ', 'JAZZ', 'live-music']})
    assert response.status_code == 201
    assert response.json()['category'] == 'music' and response.json()['tags'] == ['jazz', 'live-music']
    assert (await client.patch('/api/spaces/music', headers=bh, json={'category': 'art'})).status_code == 403
    assert (await client.patch('/api/spaces/music', headers=ch, json={'tags': ['ok']})).status_code == 403
    assert (await client.patch('/api/spaces/music', json={'tags': ['ok']})).status_code == 401
    assert (await client.patch('/api/spaces/music', headers=ah, json={'category': 'art', 'tags': ['Art', ' art ']})).json()['tags'] == ['art']
    assert (await client.patch('/api/spaces/music', headers=ah, json={'description': 'Keep category'})).json()['category'] == 'art'
    ws = await client.post('/api/spaces', headers=ah, json={'name': 'Private', 'slug': 'private', 'type': 'workspace', 'category': 'music', 'tags': ['jazz']})
    assert ws.json()['category'] == 'other' and ws.json()['tags'] == []
    assert (await client.get('/api/spaces/chat')).json()['category'] == 'other'


@pytest.mark.parametrize('values', [{'category': 'unknown'}, {'tags': ['aa','bb','cc','dd','ee','ff']}, {'tags': ['!bad']}, {'tags': ['a']}, {'category': None}, {'tags': None}])
async def test_invalid_community_fields(client, setup_chat, values):
    ah = setup_chat[3]
    assert (await client.post('/api/spaces', headers=ah, json={'name': 'Invalid', 'slug': 'invalid', 'type': 'community', **values})).status_code == 422
    assert (await client.patch('/api/spaces/chat', headers=ah, json=values)).status_code == 422


async def test_interests(client, setup_chat):
    ah, bh = setup_chat[3:5]
    assert (await client.get('/api/me/interests', headers=ah)).json() == {'categories': []}
    assert (await client.put('/api/me/interests', headers=ah, json={'categories': ['music','gaming','music']})).json() == {'categories': ['gaming','music']}
    assert (await client.get('/api/me/interests', headers=bh)).json() == {'categories': []}
    assert (await client.put('/api/me/interests', headers=ah, json={'categories': ['science']})).json() == {'categories': ['science']}
    assert (await client.put('/api/me/interests', headers=ah, json={'categories': ['unknown']})).status_code == 422
    assert (await client.put('/api/me/interests', headers=ah, json={'categories': ['music']*17})).status_code == 422
    assert (await client.put('/api/me/interests', headers=ah, json={'categories': []})).json() == {'categories': []}
    assert (await client.get('/api/me/interests')).status_code == 401
    assert (await client.put('/api/me/interests', json={'categories': []})).status_code == 401


async def test_management_and_sync(client, setup_chat, live_server):
    alice, _, _, ah, bh, ch, _, _ = setup_chat
    async with connected(live_server, alice) as (peer, _):
        updates = asyncio.Queue()
        peer.on('spaces:updated', updates.put_nowait)
        response = await client.patch('/api/me/spaces/chat', headers=ah, json={'muted': True, 'favorite': True})
        assert response.status_code == 200 and response.json()['muted'] is True
        await event(updates)
    own = (await client.get('/api/me/spaces', headers=ah)).json()[0]
    assert own['favorite'] and own['muted'] and own['role'] == 'owner'
    assert not (await client.get('/api/me/spaces', headers=bh)).json()[0]['muted']
    assert (await client.patch('/api/me/spaces/chat', headers=ch, json={'muted': True})).status_code == 404
    assert (await client.patch('/api/me/spaces/chat', json={'muted': True})).status_code == 401
    assert (await client.patch('/api/me/spaces/chat', headers=ah, json={'muted': None})).status_code == 422
    assert (await client.put('/api/me/spaces/order', headers=ah, json={'slugs': ['missing']})).status_code == 422
    assert (await client.put('/api/me/spaces/order', headers=ah, json={'slugs': ['chat','chat']})).status_code == 422
    assert (await client.put('/api/me/spaces/order', json={'slugs': []})).status_code == 401
    assert (await client.put('/api/me/spaces/order', headers=ah, json={'slugs': ['chat']})).status_code == 204
    assert (await client.get('/api/me/spaces', headers=ah)).json()[0]['position'] == 0
    assert (await client.delete('/api/spaces/chat/members/me', headers=ah)).status_code == 409


async def test_muting_keeps_mentions_dms_and_channel_unread(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, channel = setup_chat
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _):
        assert (await send(b, channel, 'Regular message'))['ok']
        assert (await client.get('/api/me/unreads', headers=ah)).json()['items'][0]['unread'] == 1
        assert (await client.patch('/api/me/spaces/chat', headers=ah, json={'muted': True})).status_code == 200
        assert (await client.get('/api/me/unreads', headers=ah)).json()['items'] == []
        assert (await client.get('/api/me/spaces', headers=ah)).json()[0]['unread'] == 0
        assert (await client.get('/api/spaces/chat/channels', headers=ah)).json()[0]['unread'] == 1
        assert (await send(b, channel, 'Hello @alice!'))['ok']
        unread = (await client.get('/api/me/unreads', headers=ah)).json()['items'][0]
        assert unread['unread'] == 1 and len(unread['items']) == 1 and '@alice' in unread['items'][0]['body']
        assert (await client.get('/api/me/spaces', headers=ah)).json()[0]['unread'] == 1
        conversation = (await client.post('/api/dms', headers=bh, json={'usernames': ['alice']})).json()
        assert (await send(b, conversation['id'], 'A direct message'))['ok']
        assert len((await client.get('/api/me/unreads', headers=ah)).json()['items']) == 2
        assert (await call(a, 'read:update', {'channelId': channel, 'messageId': unread['items'][0]['id']}))['ok']
        assert len((await client.get('/api/me/unreads', headers=ah)).json()['items']) == 1
        parent = (await send(b, channel, 'Another conversation'))['message']['id']
        reply = await call(b, 'message:send', {'channelId': channel, 'parentId': parent, 'body': 'Thread mention @alice', 'clientMsgId': __import__('uuid').uuid4().hex})
        assert reply['ok']
        places = (await client.get('/api/me/unreads', headers=ah)).json()['items']
        assert next(item for item in places if item['channel']['id'] == channel)['items'][0]['parent_id'] == parent
        assert (await client.get('/api/me/spaces', headers=ah)).json()[0]['unread'] == 1
        read_updates = asyncio.Queue()
        a.on('space:activity', read_updates.put_nowait)
        assert (await call(a, 'thread:read', {'parentId': parent, 'messageId': reply['message']['id']}))['ok']
        assert 'spaceId' in await event(read_updates)
        assert all(item['channel']['id'] != channel for item in (await client.get('/api/me/unreads', headers=ah)).json()['items'])
        assert (await client.get('/api/me/spaces', headers=ah)).json()[0]['unread'] == 0
        later_reply = await call(b, 'message:send', {'channelId': channel, 'parentId': parent, 'body': 'Another @alice mention', 'clientMsgId': __import__('uuid').uuid4().hex})
        assert later_reply['ok']
        assert (await client.get('/api/me/spaces', headers=ah)).json()[0]['unread'] == 1


async def test_personal_activity_without_watch_and_private_visibility(client, setup_chat, live_server):
    alice, bob, carol, ah, bh, _, space, channel = setup_chat
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _), connected(live_server, carol) as (c, _):
        bq, cq = asyncio.Queue(), asyncio.Queue()
        b.on('space:activity', bq.put_nowait)
        c.on('space:activity', cq.put_nowait)
        parent = await send(a, channel, 'A message in a space that is not open')
        assert (await event(bq)) == {'spaceId': space['id']}
        await quiet(cq)
        reply = await call(a, 'message:send', {'channelId': channel, 'parentId': parent['message']['id'],
            'body': 'A mention for an uninvolved member: @bob', 'clientMsgId': __import__('uuid').uuid4().hex})
        assert reply['ok']
        assert (await event(bq)) == {'spaceId': space['id']}
        await quiet(cq)
        secret = (await client.post('/api/spaces/chat/channels', headers=ah, json={'name': 'secret', 'type': 'text', 'is_private': True})).json()
        await send(a, secret['id'], 'Private activity')
        await quiet(bq)
        await quiet(cq)
        await client.delete('/api/spaces/chat/members/me', headers=bh)
        await send(a, channel, 'After leaving')
        await quiet(bq)


async def test_membership_order_and_favorites(client, setup_chat):
    ah, bh = setup_chat[3:5]
    for slug in ('alpha', 'zebra'):
        await client.post('/api/spaces', headers=ah, json={'type': 'community', 'slug': slug, 'name': slug.title()})
    await client.put('/api/me/spaces/order', headers=ah, json={'slugs': ['zebra','chat','alpha']})
    assert [x['slug'] for x in (await client.get('/api/me/spaces', headers=ah)).json()] == ['zebra','chat','alpha']
    await client.patch('/api/me/spaces/alpha', headers=ah, json={'favorite': True})
    assert [x['slug'] for x in (await client.get('/api/me/spaces', headers=ah)).json()] == ['alpha','zebra','chat']
    assert (await client.put('/api/me/spaces/order', headers=bh, json={'slugs': ['alpha']})).status_code == 422


async def test_rules_and_join_agreement(client, setup_chat):
    _, _, carol, ah, bh, ch, space, _ = setup_chat
    path = '/api/spaces/chat/rules'
    rules = [{'title': 'Be kind', 'description': 'Respect others.'}, {'title': 'Stay on topic', 'description': ''}]
    assert (await client.put(path, headers=ah, json={'rules': rules})).status_code == 200
    assert [r['title'] for r in (await client.get(path)).json()['rules']] == ['Be kind', 'Stay on topic']
    assert (await client.put(path, headers=bh, json={'rules': []})).status_code == 403
    assert (await client.put(path, headers=ch, json={'rules': []})).status_code == 403
    assert (await client.put(path, json={'rules': []})).status_code == 401
    assert (await client.put(path, headers=ah, json={'rules': rules*8})).status_code == 422
    assert (await client.put(path, headers=ah, json={'rules': [{'title': '  '}]})).status_code == 422
    rejected = await client.post('/api/spaces/chat/join', headers=ch)
    assert rejected.status_code == 409 and rejected.json()['detail']['code'] == 'rules_not_agreed'
    assert (await client.post('/api/spaces/chat/join', headers=ch, json={'agreedToRules': False})).status_code == 409
    assert (await client.post('/api/spaces/chat/join', headers=ch, json={'agreedToRules': True})).status_code == 200
    async with SessionLocal() as session:
        member = await session.scalar(select(SpaceMember).where(SpaceMember.space_id == space['id'], SpaceMember.user_id == carol['user']['id']))
        assert member.rules_agreed_at is not None
    # Existing members and rule-less communities keep their original join behaviour.
    assert (await client.post('/api/spaces/chat/join', headers=bh)).status_code == 200
    await client.put(path, headers=ah, json={'rules': []})
    await client.delete('/api/spaces/chat/members/me', headers=ch)
    assert (await client.post('/api/spaces/chat/join', headers=ch)).status_code == 200
    assert (await client.post('/api/spaces/chat/join')).status_code == 401
    await client.post('/api/spaces', headers=ah, json={'type': 'workspace', 'name': 'Private', 'slug': 'private'})
    assert (await client.get('/api/spaces/private/rules', headers=ch)).status_code == 404
    assert (await client.get('/api/spaces/private/rules')).status_code == 404
    assert (await client.put('/api/spaces/private/rules', headers=ch, json={'rules': []})).status_code == 404
    assert (await client.get('/api/spaces/private/rules', headers=ah)).status_code == 200
