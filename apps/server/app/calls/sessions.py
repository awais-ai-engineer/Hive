"""Durable meeting identity and consent coverage, separate from ephemeral socket membership."""
import time
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert

from app.db.models import HuddleMember, HuddleSegment, HuddleSession


async def lock(session, channel_id):
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": f"huddle:{channel_id}"})


async def current(session, channel_id):
    return await session.scalar(select(HuddleSession).where(
        HuddleSession.channel_id == channel_id, HuddleSession.ended_at.is_(None)))


async def join(session, channel_id, user):
    await lock(session, channel_id)
    meeting = await current(session, channel_id)
    if meeting is None:
        meeting = HuddleSession(channel_id=channel_id, created_by=user.id, meeting_start=int(time.time() * 1000))
        session.add(meeting)
        await session.flush()
    meeting.empty_since = None
    await session.execute(insert(HuddleMember).values(
        session_id=meeting.id, user_id=user.id, speaker=user.display_name or user.username,
    ).on_conflict_do_nothing())
    return meeting


async def authorized(session, meeting_id, channel_id, user_id):
    from app.messages.service import readable

    meeting = await session.get(HuddleSession, meeting_id)
    if meeting is None or meeting.channel_id != channel_id:
        raise HTTPException(404, "Huddle session not found")
    await readable(session, channel_id, user_id)
    member = await session.get(HuddleMember, (meeting_id, user_id))
    if member is None:
        raise HTTPException(403, "Only meeting participants can access this transcript")
    return meeting, member


def segment_out(row):
    return {"sessionId": row.session_id, "channelId": row.channel_id, "userId": row.user_id,
            "username": row.speaker, "segmentId": row.segment_id, "sequence": row.sequence,
            "revision": row.revision, "text": row.text, "timestamp": row.created_at.isoformat(), "final": True}


async def transcript(session, meeting, *, after=None, limit=500):
    query = select(HuddleSegment).where(HuddleSegment.session_id == meeting.id)
    if after:
        query = query.where(HuddleSegment.created_at >= after)
    rows = await session.scalars(query.order_by(HuddleSegment.created_at.desc(), HuddleSegment.user_id.desc(),
                                               HuddleSegment.sequence.desc(), HuddleSegment.segment_id.desc()).limit(limit))
    return [segment_out(row) for row in reversed(list(rows))]


async def coverage(session, meeting_id):
    members = list(await session.scalars(select(HuddleMember).where(HuddleMember.session_id == meeting_id)))
    return [{"userId": row.user_id, "name": row.speaker, "consented": row.consented,
             "state": row.capture_state, "lastSequence": row.last_sequence,
             "incompleteReason": row.incomplete_reason} for row in members]


async def status(session, meeting_id, user_id, state, reason=None):
    member = await session.get(HuddleMember, (meeting_id, user_id))
    if member is None:
        raise HTTPException(403, "You are not a participant in this meeting")
    member.capture_state = state
    if state in ("error", "interrupted", "offline") or (state == "paused" and reason and "disclosure" in reason.lower()):
        member.incomplete_reason = reason or "Speech capture was interrupted; some speech may be missing."
    await session.commit()


def meeting_out(meeting):
    return {"sessionId": meeting.id, "startedAt": meeting.started_at.isoformat(),
            "meetingStart": meeting.meeting_start, "endedAt": meeting.ended_at.isoformat() if meeting.ended_at else None}


async def mark_server_restart(session):
    for meeting in await session.scalars(select(HuddleSession).where(HuddleSession.ended_at.is_(None))):
        meeting.empty_since = datetime.now(UTC)
        for member in await session.scalars(select(HuddleMember).where(
            HuddleMember.session_id == meeting.id, HuddleMember.consented.is_(True))):
            member.capture_state = "offline"
            member.incomplete_reason = "The signaling server restarted; transcript coverage may be interrupted."
    await session.commit()
