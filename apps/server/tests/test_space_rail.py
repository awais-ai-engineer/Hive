from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.db.models import SpaceMember
from app.db.session import SessionLocal
from tests.helpers import call, connected, send


async def test_preferences_order_persists_and_is_user_scoped(client, setup_chat):
    _, _, _, ah, bh, _, space, _ = setup_chat
    work = (await client.post('/api/spaces', headers=ah, json={
        'type': 'workspace', 'name': 'Team', 'slug': 'team',
    })).json()
    order = [work['id'], space['id']]
    response = await client.patch('/api/me/preferences', headers=ah, json={'spaceOrder': order})
    assert response.status_code == 200
    assert response.json() == {'spaceOrder': order}
    assert (await client.get('/api/me/preferences', headers=ah)).json() == {'spaceOrder': order}
    assert (await client.get('/api/me/preferences', headers=bh)).json() == {'spaceOrder': [space['id']]}
    own = (await client.get('/api/me/spaces', headers=ah)).json()
    assert [row['id'] for row in own] == order
    assert [row['kind'] for row in own] == ['work', 'community']
    assert own[0]['iconUrl'] is None and own[0]['color'].startswith('#')
    assert own[0]['unreadCount'] == own[0]['mentionCount'] == 0
    assert (await client.patch('/api/me/preferences', headers=ah, json={})).json() == {'spaceOrder': order}
    assert (await client.patch('/api/me/preferences', headers=ah, json={'spaceOrder': []})).status_code == 200
    assert all(row['position'] is None for row in (await client.get('/api/me/spaces', headers=ah)).json())


@pytest.mark.parametrize('body', [
    {'spaceOrder': None}, {'spaceOrder': ['missing']}, {'spaceOrder': ['', '']},
    {'spaceOrder': ['a', 'a']}, {'spaceOrder': ['a'] * 501}, {'spaceOrder': [123]},
    {'spaceOrder': ['a' * 27]}, {'unknown': []},
])
async def test_invalid_preferences_do_not_change_order(client, setup_chat, body):
    ah = setup_chat[3]
    before = (await client.get('/api/me/preferences', headers=ah)).json()
    assert (await client.patch('/api/me/preferences', headers=ah, json=body)).status_code == 422
    assert (await client.get('/api/me/preferences', headers=ah)).json() == before


async def test_order_rejects_nonmember_and_banned_spaces(client, setup_chat):
    _, bob, _, ah, bh, ch, space, _ = setup_chat
    assert (await client.get('/api/me/preferences')).status_code == 401
    assert (await client.patch('/api/me/preferences', json={'spaceOrder': []})).status_code == 401
    assert (await client.patch('/api/me/preferences', headers=ch, json={'spaceOrder': [space['id']]})).status_code == 422
    async with SessionLocal() as session:
        member = await session.scalar(select(SpaceMember).where(SpaceMember.user_id == bob['user']['id']))
        member.banned_until = datetime.now(UTC) + timedelta(days=1)
        await session.commit()
    assert (await client.patch('/api/me/preferences', headers=bh, json={'spaceOrder': [space['id']]})).status_code == 422
    assert (await client.get('/api/me/preferences', headers=ah)).json()['spaceOrder'] == [space['id']]


async def test_real_unreads_mentions_and_private_channel_visibility(client, setup_chat, live_server):
    alice, bob, _, ah, bh, _, _, channel = setup_chat
    secret = (await client.post('/api/spaces/chat/channels', headers=ah, json={'name': 'secret', 'is_private': True})).json()
    async with connected(live_server, alice) as (a, _), connected(live_server, bob) as (b, _):
        parent = (await send(b, channel, 'Hello'))['message']['id']
        mention = (await send(b, channel, 'Hello @alice'))['message']['id']
        assert (await send(a, channel, 'My own @alice mention'))['ok']
        assert (await send(a, secret['id'], '@bob private mention'))['ok']
        response = (await client.get('/api/me/spaces', headers=ah)).json()[0]
        assert response['unreadCount'] == 2 and response['mentionCount'] == 1
        assert (await client.get('/api/me/spaces', headers=bh)).json()[0]['mentionCount'] == 0
        assert (await call(a, 'read:update', {'channelId': channel, 'messageId': mention}))['ok']
        reply = await call(b, 'message:send', {'channelId': channel, 'parentId': parent, 'body': '@alice in a thread', 'clientMsgId': uuid4().hex})
        assert reply['ok']
        response = (await client.get('/api/me/spaces', headers=ah)).json()[0]
        assert response['unreadCount'] == 0 and response['mentionCount'] == 1
        assert (await call(a, 'thread:read', {'parentId': parent, 'messageId': reply['message']['id']}))['ok']
        assert (await client.get('/api/me/spaces', headers=ah)).json()[0]['mentionCount'] == 0


def test_documented_navigation_contract_matches_fastapi():
    import json
    from pathlib import Path

    from app.main import api

    documented = json.loads((Path(__file__).resolve().parents[3] / 'openapi.yaml').read_text())
    live = api.openapi()
    for path, operations in documented['paths'].items():
        assert operations == live['paths'][path]
    for name, schema in documented['components']['schemas'].items():
        assert schema == live['components']['schemas'][name]
