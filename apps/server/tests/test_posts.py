import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import MemberRole, Post, SpaceMember, User
from app.db.session import SessionLocal
from app.posts.ranking import hot_score
from tests.helpers import call, connected, event


async def create(client, headers, **data):
    return await client.post('/api/spaces/chat/posts', headers=headers,
                             json={'title': 'A post', **data})


async def test_create_permissions_validation(client, setup_chat):
    _alice, bob, _, ah, bh, ch, space, _ = setup_chat
    for data in ({'body': ' text '}, {'url': 'https://www.example.com/x'}, {}):
        response = await create(client, ah, **data)
        assert response.status_code == 201, response.text
        if 'url' in data:
            assert response.json()['domain'] == 'example.com'
    for data in ({'title': ''}, {'title': 'x' * 301}, {'body': 'x', 'url': 'https://example.com'},
                 {'url': 'ftp://example.com'}, {'body': 'x' * 40001}):
        assert (await create(client, ah, **data)).status_code == 422
    assert (await create(client, {})).status_code == 401
    assert (await create(client, ch)).status_code == 403
    async with SessionLocal() as session:
        member = await session.get(SpaceMember, (space['id'], bob['user']['id']))
        member.role = MemberRole.guest
        await session.commit()
    assert (await create(client, bh)).status_code == 403
    await client.post('/api/spaces', headers=ah, json={
        'type': 'workspace', 'name': 'Private', 'slug': 'private'})
    assert (await client.post('/api/spaces/private/posts', headers=bh,
                              json={'title': 'Private'})).status_code == 404


async def test_rate_limit(client, setup_chat):
    ah = setup_chat[3]
    for _ in range(5):
        assert (await create(client, ah)).status_code == 201
    assert (await create(client, ah)).status_code == 429


async def test_votes_edit_delete(client, setup_chat):
    _, bob, _, ah, bh, ch, space, _ = setup_chat
    post = (await create(client, ah, body='Original')).json()
    path = f"/api/posts/{post['id']}"
    for value, score, up, down in ((1, 1, 1, 0), (1, 1, 1, 0), (-1, -1, 0, 1), (0, 0, 0, 0)):
        response = await client.put(path + '/vote', headers=bh, json={'value': value})
        assert response.json() == {'score': score, 'upvotes': up, 'downvotes': down, 'my_vote': value}
    await client.put(path + '/vote', headers=bh, json={'value': 1})
    assert (await client.get(path, headers=bh)).json()['my_vote'] == 1
    assert (await client.get(path, headers=ah)).json()['my_vote'] == 0
    assert (await client.put(path + '/vote', headers=ch, json={'value': 1})).status_code == 403
    assert (await client.patch(path, headers=bh, json={'body': 'No'})).status_code == 403
    assert (await client.patch(path, headers=ah, json={'title': 'No'})).status_code == 422
    edited = await client.patch(path, headers=ah, json={'body': 'Changed'})
    assert edited.json()['edited_at'] and edited.json()['body'] == 'Changed'
    async with SessionLocal() as session:
        member = await session.get(SpaceMember, (space['id'], bob['user']['id']))
        member.role = MemberRole.moderator
        await session.commit()
    assert (await client.delete(path, headers=bh)).status_code == 204
    deleted = (await client.get(path)).json()
    assert deleted['deleted'] and deleted['title'] == '[deleted]'
    assert deleted['body'] is None and deleted['url'] is None and deleted['author'] is None
    assert (await client.get('/api/spaces/chat/posts')).json()['items'] == []
    assert (await client.put(path + '/vote', headers=ah, json={'value': 1})).status_code == 422


async def test_concurrent_votes(client, setup_chat):
    from app.auth.security import create_access_token

    _, _, _, ah, _, _, space, _ = setup_chat
    post = (await create(client, ah)).json()
    async with SessionLocal() as session:
        ids = []
        for i in range(20):
            user = User(username=f'voter{i}', email=f'voter{i}@example.com', password_hash='unused')
            session.add(user)
            await session.flush()
            ids.append(user.id)
            session.add(SpaceMember(space_id=space['id'], user_id=user.id, role=MemberRole.member))
        await session.commit()
    responses = await asyncio.gather(*[client.put(f"/api/posts/{post['id']}/vote",
        headers={'Authorization': f'Bearer {create_access_token(user_id)}'}, json={'value': 1})
        for user_id in ids])
    assert all(response.status_code == 200 for response in responses)
    result = (await client.get(f"/api/posts/{post['id']}")).json()
    assert result['score'] == result['upvotes'] == 20 and result['downvotes'] == 0


@pytest.mark.parametrize('sort', ['new', 'hot', 'top'])
async def test_pagination(client, setup_chat, sort):
    alice, _, _, _, _, _, space, _ = setup_chat
    async with SessionLocal() as session:
        for i in range(60):
            session.add(Post(space_id=space['id'], author_id=alice['user']['id'],
                             title=str(i), score=i, hot=float(i)))
        await session.commit()
    cursor = None
    ids = []
    sizes = []
    for _ in range(3):
        params = {'sort': sort, 't': 'all'}
        if cursor:
            params['cursor'] = cursor
        response = (await client.get('/api/spaces/chat/posts', params=params)).json()
        sizes.append(len(response['items']))
        ids.extend(item['id'] for item in response['items'])
        cursor = response['next_cursor']
    assert sizes == [25, 25, 10] and len(set(ids)) == 60 and cursor is None
    assert (await client.get('/api/spaces/chat/posts', params={'cursor': 'garbage'})).status_code == 422


async def test_sorting_and_feed(client, setup_chat):
    alice, _, _, ah, _, ch, space, _ = setup_chat
    now = datetime.now(UTC)
    async with SessionLocal() as session:
        for title, score, age in [('Old popular', 100, 30), ('Recent', 1, 0)]:
            created = now - timedelta(days=age)
            session.add(Post(space_id=space['id'], author_id=alice['user']['id'],
                             title=title, score=score, hot=hot_score(score, created), created_at=created))
        await session.commit()
    for sort, period, first in [('top', 'all', 'Old popular'), ('top', 'day', 'Recent'),
                                ('hot', 'all', 'Recent')]:
        items = (await client.get('/api/spaces/chat/posts', params={'sort': sort, 't': period})).json()['items']
        assert items[0]['title'] == first
    assert len((await client.get('/api/feed', headers=ah)).json()['items']) == 2
    assert (await client.get('/api/feed', headers=ch)).json()['items'] == []
    await client.post('/api/spaces', headers=ah, json={'type': 'workspace', 'name': 'Private', 'slug': 'private'})
    private = (await client.post('/api/spaces/private/posts', headers=ah, json={'title': 'Secret'})).json()
    assert (await client.get(f"/api/posts/{private['id']}")).status_code == 404
    assert len((await client.get('/api/feed')).json()['items']) == 2


async def test_realtime(client, setup_chat, live_server):
    alice, _, _, ah, _, _, space, _ = setup_chat
    async with connected(live_server, alice) as (peer, _):
        queues = {name: asyncio.Queue() for name in ('post:new', 'post:score')}
        for name, queue in queues.items():
            peer.on(name, queue.put_nowait)
        assert (await call(peer, 'space:watch', {'spaceId': space['id']}))['ok']
        post = (await create(client, ah)).json()
        assert (await event(queues['post:new'])) == {'postId': post['id'], 'spaceId': space['id']}
        await client.put(f"/api/posts/{post['id']}/vote", headers=ah, json={'value': 1})
        assert (await event(queues['post:score']))['score'] == 1


async def test_edit_keeps_fields_not_sent(client, setup_chat):
    _, _, _, ah, _, _, _, _ = setup_chat
    link = (await client.post("/api/spaces/chat/posts", headers=ah, json={
        "title": "A link", "url": "https://example.com/a"})).json()
    moved = await client.patch(f"/api/posts/{link['id']}", headers=ah, json={"url": "https://example.com/b"})
    assert moved.json()["url"] == "https://example.com/b"
    assert (await client.patch(f"/api/posts/{link['id']}", headers=ah, json={"body": "Text"})).status_code == 422
    text = (await client.post("/api/spaces/chat/posts", headers=ah, json={
        "title": "Text", "body": "Original"})).json()
    edited = (await client.patch(f"/api/posts/{text['id']}", headers=ah, json={"body": "Changed"})).json()
    assert edited["body"] == "Changed" and edited["url"] is None and edited["edited_at"]
