"""Consent-checked, exact-track PCM forwarding to an operator-owned speech worker."""
import io
import math
import wave

import httpx
from fastapi import HTTPException
from sqlalchemy import select

from app.calls import service, sessions
from app.calls.schemas import CaptionIn
from app.calls.transcripts import publish_caption
from app.core.config import settings
from app.db.models import HuddleMember, HuddleSegment


async def transcribe_chunk(db, user, *, channel_id, meeting_id, sid, chunk_id, sequence, run_id, start_ms, final, language, audio):
    if not settings.transcription_url or not settings.transcription_token:
        raise HTTPException(503, 'The self-hosted speech worker is not configured')
    if len(audio) > 512000:
        raise HTTPException(413, 'Speech window exceeds its size limit')
    try:
        with wave.open(io.BytesIO(audio)) as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000 or wav.getnframes() > 160000:
                raise ValueError('Expected at most ten seconds of mono 16 kHz PCM')
            duration = wav.getnframes() / 16000
    except (wave.Error, EOFError, ValueError):
        raise HTTPException(422, 'Invalid PCM speech window') from None
    room = await service.participants(channel_id)
    entry = room.get(sid)
    if not entry or entry['userId'] != user.id or entry.get('sessionId') != meeting_id or not entry.get('captions'):
        raise HTTPException(403, 'This microphone does not own active transcription consent')
    from app.realtime.socket import _call_limited
    if _call_limited(sid, 'speech-window', 20):
        raise HTTPException(429, 'Speech processing is throttled; retry the same window')
    await service.caption_consent(channel_id, sid, user.id, True)
    meeting, _ = await sessions.authorized(db, meeting_id, channel_id, user.id)
    member = await db.scalar(select(HuddleMember).where(HuddleMember.session_id == meeting_id,
        HuddleMember.user_id == user.id).with_for_update())
    existing = await db.get(HuddleSegment, (channel_id, meeting.meeting_start, user.id, chunk_id))
    if existing:
        return {'segment': sessions.segment_out(existing)}
    cursor = dict(member.capture_cursor or {})
    previous = float(cursor.get(run_id, 0))
    # Silence-only windows are acknowledged too; a replay must not invoke inference again.
    window_end = start_ms / 1000 + duration
    commit_until = window_end if final else max(start_ms / 1000, window_end - .35)
    if commit_until <= previous:
        return {'segment': None}
    async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=5)) as client:
        try:
            result = await client.post(settings.transcription_url.rstrip('/') + '/transcribe',
                headers={'Authorization': f'Bearer {settings.transcription_token}'},
                data={'language': language}, files={'audio': ('speech.wav', audio, 'audio/wav')})
            result.raise_for_status()
            words = result.json()['words']
            if not isinstance(words, list) or len(words) > 2000:
                raise ValueError('Invalid speech worker response')
        except (httpx.HTTPError, ValueError, KeyError):
            member.incomplete_reason = 'The speech worker was unavailable; buffered audio may be incomplete.'
            await db.commit()
            raise HTTPException(503, 'Speech processing is unavailable. Keep the Huddle open to retry.') from None
    kept = []
    for word in words:
        if not isinstance(word, dict) or not isinstance(word.get('word'), str):
            continue
        try:
            end = start_ms / 1000 + float(word['end'])
            beginning = start_ms / 1000 + float(word['start'])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(beginning) or not math.isfinite(end) or end < beginning:
            continue
        if beginning < start_ms / 1000 - .1 or end > window_end + .2:
            continue
        if end > previous + .015 and end <= commit_until + .015:
            kept.append(word['word'])
    text = ''.join(kept).strip()
    if len(text) > 4000:
        raise HTTPException(502, 'Speech processing returned an oversized segment; the audio window remains pending')
    cursor[run_id] = commit_until
    member.capture_cursor = dict(list(cursor.items())[-100:])
    # Persist the cursor and the segment in the same transaction in publish_caption.
    if text:
        return await publish_caption(sid, CaptionIn(channelId=channel_id, sessionId=meeting_id,
            segmentId=chunk_id, sequence=sequence, revision=1, text=text, final=True), db, user)
    await db.commit()
    return {'segment': None}
