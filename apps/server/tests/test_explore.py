import base64
import json

import pytest


async def create(client, headers, slug, category='music', **extra):
    response = await client.post('/api/spaces', headers=headers, json={'name': slug.title(), 'slug': slug, 'type': 'community', 'category': category, **extra})
    assert response.status_code == 201
    return response.json()


async def browse(client, headers=None, **params):
    response = await client.get('/api/explore/communities', headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


async def test_explore_sets_counts_and_filters(client, setup_chat):
    ah, bh = setup_chat[3:5]
    first = await create(client, ah, 'jazz', tags=['jazz-music'], description='A hundred percent 100%_real')
    await create(client, ah, 'forest', 'nature')
    await create(client, ah, 'secret', type='workspace')
    await client.post('/api/spaces/jazz/posts', headers=ah, json={'title': 'Welcome to jazz'})
    fallback = await browse(client, bh, tab='for_you')
    trending = await browse(client, bh, tab='trending')
    assert fallback['needsInterests'] and [x['id'] for x in fallback['items']] == [x['id'] for x in trending['items']]
    assert all(item['type'] == 'community' and item['slug'] != 'secret' for item in trending['items'])
    jazz = next(item for item in trending['items'] if item['id'] == first['id'])
    assert jazz['postCount7d'] == 1 and jazz['memberCount'] == 1 and not jazz['joined']
    await client.put('/api/me/interests', headers=bh, json={'categories': ['music']})
    assert [x['slug'] for x in (await browse(client, bh, tab='for_you'))['items']] == ['jazz']
    await client.post('/api/spaces/jazz/join', headers=bh)
    assert (await browse(client, bh, tab='for_you'))['items'] == []
    following = await browse(client, bh, tab='following')
    assert [x['slug'] for x in following['items']] == ['jazz', 'chat']
    assert following['items'][0]['role'] == 'member'
    assert (await browse(client, tab='following'))['items'] == []
    assert {x['slug'] for x in (await browse(client, tab='recent'))['items']} == {'jazz','forest','chat'}
    assert [x['slug'] for x in (await browse(client, category='nature'))['items']] == ['forest']
    assert [x['slug'] for x in (await browse(client, q='JAZZ-MUSIC'))['items']] == ['jazz']
    assert [x['slug'] for x in (await browse(client, q='%_'))['items']] == ['jazz']
    assert (await browse(client, q='nonexistent'))['items'] == []
    counts = {x['slug']: x['count'] for x in (await client.get('/api/explore/categories')).json()['categories']}
    assert counts['music'] == 1 and counts['nature'] == 1 and counts['other'] == 1 and len(counts) == 16


@pytest.mark.parametrize('tab', ['for_you','following','recent','trending'])
async def test_explore_stable_pagination(client, setup_chat, tab):
    ah = setup_chat[3]
    for index in range(5):
        await create(client, ah, f'music-{index}')
    full = [item['id'] for item in (await browse(client, ah, tab=tab))['items']]
    seen, cursor = [], None
    for _ in range(10):
        page = await browse(client, ah, tab=tab, limit=2, **({'cursor': cursor} if cursor else {}))
        seen.extend(item['id'] for item in page['items'])
        cursor = page['nextCursor']
        if not cursor:
            break
    assert seen == full and len(seen) == len(set(seen))


@pytest.mark.parametrize('params', [{'tab':'bad'}, {'category':'bad'}, {'limit':0}, {'limit':51}, {'q':'a'*201}, {'cursor':'broken'}, {'cursor':'W10='}])
async def test_explore_validation(client, params):
    assert (await client.get('/api/explore/communities', params=params)).status_code == 422


@pytest.mark.parametrize('patch', [{'id': '\u0000'}, {'id': 'not-an-id'}, {'rank': '1e2000000000'}, {'rank': '1e-2000000000'}, {'rank': '0e99999999'}, {'rank': '-1'}, {'rank': 'NaN'}, {'rank': []}])
async def test_explore_rejects_malformed_cursor_values(client, setup_chat, patch):
    ah = setup_chat[3]
    await create(client, ah, 'second-community')
    page = await browse(client, ah, tab='trending', limit=1)
    assert page['nextCursor']
    cursor = json.loads(base64.urlsafe_b64decode(page['nextCursor']))
    cursor.update(patch)
    encoded = base64.urlsafe_b64encode(json.dumps(cursor).encode()).decode()
    assert (await client.get('/api/explore/communities', headers=ah, params={'tab': 'trending', 'limit': 1, 'cursor': encoded})).status_code == 422
