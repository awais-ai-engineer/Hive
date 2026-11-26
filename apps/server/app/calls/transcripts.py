from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy.dialects.postgresql import insert

from app.calls import service as calls
from app.calls import sessions as meetings
from app.core.config import settings
from app.db.models import HuddleSegment
from app.db.session import redis


async def publish_caption(sid, data, session, user):
    from app.realtime.socket import _call_limited, sio
    """Live captions: each browser transcribes its own speaker and shares the text with the call only."""
    room = await calls.participants(data.channelId)
    if sid not in room:
        raise HTTPException(403, "You are not in this call")
    if room[sid].get("muted") and not data.final:
        raise HTTPException(409, "Unmute before sharing captions")
    if not room[sid].get("captions") and not data.final:
        raise HTTPException(403, "Enable transcription before sharing captions")
    if _call_limited(sid, "caption", 240):
        raise HTTPException(429, "Too many captions")
    text = data.text.strip()
    if not text:
        raise HTTPException(422, "Caption is empty")
    meeting_id = room[sid].get('sessionId')
    if data.sessionId and data.sessionId != meeting_id:
        raise HTTPException(409, 'This segment belongs to a different Huddle session')
    meeting, member = await meetings.authorized(session, meeting_id, data.channelId, user.id)
    if not room[sid].get('captions') and not member.consented:
        raise HTTPException(403, 'Transcription consent is required')
    draining = await redis.get(f'{settings.socketio_channel}:caption-drain:{meeting.id}:{user.id}') == sid
    if room[sid].get('muted') and not draining:
        raise HTTPException(409, 'Unmute before sharing captions')
    if not room[sid].get('captions') and not draining:
        raise HTTPException(403, 'Transcription consent is no longer active')
    segment_id = data.segmentId
    if room[sid].get("captions"):
        await calls.caption_consent(data.channelId, sid, user.id, True)
    call_start = await redis.hget(calls.meta_key(data.channelId), "start")
    if call_start is None:
        raise HTTPException(409, "This Huddle has expired. Rejoin before sharing captions.")
    final_key = f"{settings.socketio_channel}:caption-final:{data.channelId}:{call_start}:{user.id}:{segment_id}"
    if data.final:
        inserted = await session.scalar(insert(HuddleSegment).values(
            channel_id=data.channelId, meeting_start=meeting.meeting_start, session_id=meeting.id,
            sequence=data.sequence, revision=data.revision, user_id=user.id,
            segment_id=segment_id, speaker=user.display_name or user.username, text=text,
        ).on_conflict_do_nothing().returning(HuddleSegment.segment_id))
        member.last_sequence = max(member.last_sequence, data.sequence)
        await session.commit()
        if inserted is None:
            existing = await session.get(HuddleSegment, (data.channelId, meeting.meeting_start, user.id, segment_id))
            return {'segment': meetings.segment_out(existing)}
        await redis.set(final_key, 1, ex=12 * 3600)
        await calls.add_note(data.channelId, user.username, text)
    elif await redis.exists(final_key):
        return
    event = {"sessionId": meeting.id, "channelId": data.channelId, "sid": sid, "userId": user.id,
             "segmentId": segment_id, "sequence": data.sequence, "revision": data.revision,
             "timestamp": datetime.now(UTC).isoformat(), "username": user.display_name or user.username,
             "text": text, "final": data.final}
    if data.final:
        persisted = await session.get(HuddleSegment, (data.channelId, meeting.meeting_start, user.id, segment_id))
        event = {**meetings.segment_out(persisted), 'sid': sid}
    else:
        revision_key = f'{settings.socketio_channel}:caption-revision:{meeting.id}:{user.id}:{segment_id}'
        newer = await redis.eval("local old=tonumber(redis.call('GET',KEYS[1]) or '-1'); if tonumber(ARGV[1])<=old then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'EX',120); return 1", 1, revision_key, data.revision)
        if not newer:
            return
    await sio.emit('call:caption', event, room=f'call:{data.channelId}')
    return {'segment': event}
