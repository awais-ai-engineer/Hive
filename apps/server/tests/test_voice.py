import json
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.core.config import settings
from app.db.models import User
from app.db.session import SessionLocal
from app.messages.schemas import SendIn
from app.messages.service import send
from app.storage.media import detect_kind
from app.uploads.schemas import AudioMetadata


def element(tag, body):
    return bytes.fromhex(tag) + bytes([0x80 | len(body)]) + body


def webm(*types):
    tracks = b''.join(element('ae', element('83', bytes([kind]))) for kind in types)
    return element('1a45dfa3', b'') + element('18538067', element('1654ae6b', tracks))


@pytest.mark.parametrize('data,declared,expected', [
    (webm(2), 'audio/webm;codecs=opus', ('audio', 'audio/webm')),
    (webm(1, 2), 'audio/webm', ('file', 'application/octet-stream')),
    (webm(2, 1), 'audio/webm', ('file', 'application/octet-stream')),
    (webm(1), 'video/webm', ('video', 'video/webm')),
    (webm(2), '', ('video', 'video/webm')),
    (webm(), 'audio/webm', ('file', 'application/octet-stream')),
    (b'\x1a\x45\xdf\xa3', 'audio/webm', ('file', 'application/octet-stream')),
    (webm(2)[:-1], 'audio/webm', ('file', 'application/octet-stream')),
    (b'\x1a\x45\xdf\xa3\x80\x18\x53\x80\x67\xff' + element('1654ae6b', element('ae', element('83', b'\x02'))), 'audio/webm', ('audio', 'audio/webm')),
    (b'OggS123', 'audio/ogg', ('audio', 'audio/ogg')),
    (b'\x00\x00\x00\x18ftypM4A ', 'audio/mp4', ('audio', 'audio/mp4')),
    (b'\x00\x00\x00\x18ftypisom', 'audio/mp4', ('video', 'video/mp4')),
    (b'<html>fake', 'audio/webm', ('file', 'application/octet-stream')),
])
def test_audio_detection(data, declared, expected):
    assert detect_kind(data, declared) == expected


@pytest.mark.parametrize('patch', [
    {'durationMs': 0}, {'durationMs': 300001}, {'durationMs': True},
    {'waveform': [0] * 63}, {'waveform': [0] * 65}, {'waveform': [101] * 64},
    {'waveform': [-1] * 64}, {'waveform': [1.5] * 64}, {'waveform': [True] * 64},
])
def test_voice_metadata_validation(patch):
    with pytest.raises(ValidationError):
        AudioMetadata.model_validate({'durationMs': 1000, 'waveform': [0] * 64, **patch})


async def test_voice_upload(client, setup_chat, monkeypatch):
    path = f'/api/channels/{setup_chat[7]}/uploads'
    metadata = {'kind': 'audio', 'durationMs': '1000', 'waveform': json.dumps([40] * 64)}
    files = {'file': ('voice.webm', webm(2), 'audio/webm;codecs=opus')}
    assert (await client.post(path, files=files, data=metadata)).status_code == 401
    assert (await client.post(path, files=files, data=metadata, headers=setup_chat[5])).status_code == 403
    response = await client.post(path, files=files, data=metadata, headers=setup_chat[3])
    assert response.status_code == 201, response.text
    attachment = response.json()
    assert attachment['kind'] == 'audio' and attachment['durationMs'] == 1000
    assert attachment['waveform'] == [40] * 64
    async with SessionLocal() as session:
        user = await session.get(User, setup_chat[0]['user']['id'])
        await send(session, user, SendIn(channelId=setup_chat[7], clientMsgId=str(uuid4()),
                                        kind='voice', attachmentIds=[attachment['id']]))
    history = await client.get(f'/api/channels/{setup_chat[7]}/messages', headers=setup_chat[3])
    message = history.json()['items'][0]
    assert message['kind'] == 'voice'
    assert message['attachments'][0]['waveform'] == [40] * 64
    assert message['attachments'][0]['durationMs'] == 1000
    downloaded = await client.get(attachment['url'])
    assert downloaded.headers['content-type'] == 'audio/webm'
    assert downloaded.headers['content-disposition'].startswith('inline')
    for changes in [{'waveform': '[1]'}, {'waveform': '[true]' }, {'durationMs': '300001'},
                    {'kind': 'file'}]:
        assert (await client.post(path, files=files, data={**metadata, **changes},
                                  headers=setup_chat[3])).status_code == 422
    fake = {'file': ('fake.webm', b'not audio', 'audio/webm')}
    assert (await client.post(path, files=fake, data=metadata, headers=setup_chat[3])).status_code == 422
    disguised = {'file': ('video.webm', webm(1, 2), 'audio/webm')}
    assert (await client.post(path, files=disguised, data=metadata, headers=setup_chat[3])).status_code == 422
    monkeypatch.setattr(settings, 'max_audio_mb', 1)
    too_large = {'file': ('large.ogg', b'OggS' + b'x' * 1048576, 'audio/ogg')}
    assert (await client.post(path, files=too_large, data=metadata, headers=setup_chat[3])).status_code == 413
