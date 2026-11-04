from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

from app.core.config import Settings, settings
from app.db.models import Attachment, new_id
from app.db.session import SessionLocal, redis
from app.storage import get_storage
from app.storage.base import SignRequest
from app.storage.local import LocalStorage
from app.storage.media import detect_kind
from app.storage.supabase import SupabaseStorage

PNG = b"\x89PNG\r\n\x1a\n"
MP4 = b"\x00\x00\x00\x18ftypisom" + b"x" * 100


@pytest.mark.parametrize('data,kind,mime', [
    (PNG, 'image', 'image/png'), (b'\xff\xd8\xff', 'image', 'image/jpeg'),
    (b'GIF87a', 'image', 'image/gif'), (b'GIF89a', 'image', 'image/gif'),
    (b'RIFF0000WEBP', 'image', 'image/webp'), (MP4, 'video', 'video/mp4'),
    (b'\x1a\x45\xdf\xa3', 'video', 'video/webm'),
    (b'<html>', 'file', 'application/octet-stream'), (b'<svg>', 'file', 'application/octet-stream'),
])
def test_detect(data, kind, mime):
    assert detect_kind(data) == (kind, mime)


async def upload(client, headers, path, data=PNG, name='photo.png'):
    return await client.post(path, headers=headers, files={'file': (name, data, 'text/html')})


async def test_limits_ranges_legacy(client, setup_chat):
    alice, _, _, ah, _, _, _, channel = setup_chat
    path = f'/api/channels/{channel}/uploads'
    root = Path(settings.upload_dir)
    before = set(root.rglob('*'))
    assert (await upload(client, ah, path, PNG + b'x' * 1048576)).status_code == 413
    assert {p for p in root.rglob('*') if p.is_file()} == {p for p in before if p.is_file()}
    assert (await upload(client, ah, path, b'')).status_code == 422
    file = (await upload(client, ah, path, b'x')).json()
    assert file['kind'] == 'file'
    video = await upload(client, ah, path, MP4 + b'x' * 1048576)
    assert video.status_code == 201 and video.json()['kind'] == 'video'
    response = await client.get(video.json()['url'], headers={'Range': 'bytes=0-9'})
    assert response.status_code == 206 and len(response.content) == 10
    assert response.headers['content-range'] == f'bytes 0-9/{len(MP4) + 1048576}'
    assert response.headers['content-type'] == 'video/mp4'
    assert response.headers['content-disposition'].startswith('inline')
    renamed = (await upload(client, ah, path, b'<html>', 'renamed.png')).json()
    assert renamed['kind'] == 'file'
    download = await client.get(renamed['url'])
    assert download.headers['content-disposition'].startswith('attachment')
    assert download.headers['x-content-type-options'] == 'nosniff'
    legacy_id = new_id()
    (root / legacy_id).write_bytes(PNG)
    async with SessionLocal() as session:
        session.add(Attachment(id=legacy_id, channel_id=channel, uploader_id=alice['user']['id'],
            filename='old.png', content_type='image/png', size=len(PNG), storage_key=legacy_id, kind='image'))
        await session.commit()
    url = (await LocalStorage().signed_urls([SignRequest(legacy_id, 'old.png', True)]))[legacy_id]
    assert (await client.get(url)).content == PNG


async def test_supabase(client, setup_chat, monkeypatch, caplog):
    monkeypatch.setattr(settings, 'supabase_url', 'https://example.supabase.co')
    monkeypatch.setattr(settings, 'supabase_service_key', 'secret-never-log')
    requests = []
    async def handler(request):
        requests.append((request, await request.aread()))
        if '/sign/' in str(request.url):
            return httpx.Response(200, json=[{'path': str(i), 'signedURL': f'/object/sign/hive-media/{i}?token=ok'} for i in range(3)])
        return httpx.Response(200, json={})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        storage = SupabaseStorage(http)
        async def chunks():
            yield b'hello'
        await storage.save('attachments/test', chunks(), 'video/mp4')
        request, body = requests[0]
        assert str(request.url).endswith('/storage/v1/object/hive-media/attachments/test')
        assert body == b'hello' and request.headers['apikey'] == 'secret-never-log'
        assert request.headers['x-upsert'] == 'false'
        items = [SignRequest(str(i), 'a file.txt', i != 2) for i in range(3)]
        for item in items:
            await redis.delete(f'media-url:{item.key}:{item.inline}')
        urls = await storage.signed_urls(items)
        assert len(requests) == 2
        assert urls['0'].startswith('https://example.supabase.co/storage/v1/object/sign/')
        assert '&download=a%20file.txt' in urls['2']
        assert await storage.signed_urls(items) == urls and len(requests) == 2
        await storage.delete(['attachments/test'])
        assert requests[-1][0].method == 'DELETE' and b'prefixes' in requests[-1][1]
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(500))) as http:
        broken = SupabaseStorage(http)
        monkeypatch.setattr('app.uploads.router.get_storage', lambda: broken)
        response = await upload(client, setup_chat[3], f'/api/channels/{setup_chat[7]}/uploads')
        assert response.status_code == 502 and response.json()['detail'] == 'Storage unavailable'
    assert 'secret-never-log' not in caplog.text


async def test_media_posts(client, setup_chat, monkeypatch):
    _, _, _, ah, bh, _, _, channel = setup_chat
    path = '/api/spaces/chat/uploads'
    files = [(await upload(client, ah, path)).json() for _ in range(3)]
    video = (await upload(client, ah, path, MP4)).json()
    async def create(ids, **extra):
        await redis.delete(f"rl:post:{setup_chat[0]['user']['id']}")
        return await client.post('/api/spaces/chat/posts', headers=ah,
                                json={'title': 'Gallery', 'mediaIds': ids, **extra})
    gallery = await create([file['id'] for file in files])
    assert gallery.status_code == 201, gallery.text
    post = gallery.json()
    assert [item['id'] for item in post['media']] == [file['id'] for file in files]
    assert (await create([video['id']])).status_code == 201
    fresh = (await upload(client, ah, path)).json()
    fresh_video = (await upload(client, ah, path, MP4)).json()
    for ids, extra in [([fresh['id'], fresh_video['id']], {}), ([fresh['id']] * 11, {}),
                       ([files[0]['id']], {}), ([fresh['id']], {'url': 'https://example.com'})]:
        assert (await create(ids, **extra)).status_code == 422
    other = (await upload(client, bh, path)).json()
    assert (await create([other['id']])).status_code == 422
    chat = (await upload(client, ah, f'/api/channels/{channel}/uploads')).json()
    assert (await create([chat['id']])).status_code == 422
    storage = get_storage()
    spy = AsyncMock(wraps=storage.signed_urls)
    monkeypatch.setattr(storage, 'signed_urls', spy)
    feed = await client.get('/api/spaces/chat/posts')
    assert feed.status_code == 200 and spy.await_count == 1
    cleanup = AsyncMock(wraps=storage.delete)
    monkeypatch.setattr(storage, 'delete', cleanup)
    assert (await client.delete(f"/api/posts/{post['id']}", headers=ah)).status_code == 204
    assert len(cleanup.call_args.args[0]) == 3
    assert (await client.get(f"/api/posts/{post['id']}")).json()['media'] == []


def test_startup():
    config = Settings(_env_file=None, storage_driver='supabase', supabase_url='', supabase_service_key='')
    with pytest.raises(ValueError, match='SUPABASE_URL'):
        config.validate_storage()


async def test_migration_backfill(client, setup_chat):
    import importlib.util

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import text

    from app.db.session import engine

    migration_path = Path(__file__).parents[1] / 'alembic/versions/45cca230f940_09_media_storage.py'
    spec = importlib.util.spec_from_file_location('media_migration', migration_path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    attachment_id = new_id()
    (Path(settings.upload_dir) / attachment_id).write_bytes(PNG)
    def migrate(connection):
        with Operations.context(MigrationContext.configure(connection)):
            migration.downgrade()
            connection.execute(text('''INSERT INTO attachments
                (id,channel_id,uploader_id,filename,content_type,size)
                VALUES (:id,:channel,:user,'legacy.png','image/png',8)'''),
                {'id': attachment_id, 'channel': setup_chat[7], 'user': setup_chat[0]['user']['id']})
            migration.upgrade()
    async with engine.begin() as connection:
        await connection.run_sync(migrate)
    async with SessionLocal() as session:
        file = await session.get(Attachment, attachment_id)
        assert file.storage_key == attachment_id and file.kind == 'image'
    url = (await LocalStorage().signed_urls([SignRequest(attachment_id, 'legacy.png', True)]))[attachment_id]
    response = await client.get(url)
    assert response.status_code == 200 and response.content == PNG


async def test_supabase_skips_objects_it_cannot_sign(monkeypatch):
    monkeypatch.setattr(settings, 'supabase_url', 'https://example.supabase.co')
    monkeypatch.setattr(settings, 'supabase_service_key', 'secret-never-log')
    def handler(request):
        return httpx.Response(200, json=[
            {'path': 'ok', 'signedURL': '/object/sign/hive-media/ok?token=1'},
            {'path': 'gone', 'signedURL': None, 'error': 'Object not found'},
        ])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        items = [SignRequest('ok', 'a.png', True), SignRequest('gone', 'b.png', True)]
        for item in items:
            await redis.delete(f'media-url:{item.key}:{item.inline}')
        urls = await SupabaseStorage(http).signed_urls(items)
    # One missing object must not take down the whole page of messages or posts.
    assert list(urls) == ['ok']
