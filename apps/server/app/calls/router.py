from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.calls import invitations, service, sessions
from app.calls.schemas import CallSummary
from app.core.config import settings
from app.db.models import HuddleSession, User
from app.db.session import get_session

router = APIRouter(tags=["calls"])


@router.get("/calls", response_model=list[CallSummary])
async def active_calls(
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
):
    """Huddles and voice rooms with people in them, limited to what the viewer may read."""
    return await service.active_summaries(session, user)


@router.get('/calls/invitations')
async def invitation_snapshot(session: Annotated[AsyncSession, Depends(get_session)],
                              user: Annotated[User, Depends(get_current_user)], history: bool = False):
    return await invitations.snapshot(session, user.id, history)


@router.get('/calls/sessions/{meeting_id}/transcript')
async def meeting_transcript(meeting_id: str, session: Annotated[AsyncSession, Depends(get_session)],
                             user: Annotated[User, Depends(get_current_user)],
                             offset: int = Query(default=0, ge=0), limit: int = Query(default=500, ge=1, le=1000)):
    from sqlalchemy import select

    from app.db.models import HuddleSegment
    meeting = await session.get(HuddleSession, meeting_id)
    if meeting is None:
        raise HTTPException(404, 'Huddle session not found')
    await sessions.authorized(session, meeting_id, meeting.channel_id, user.id)
    rows = list(await session.scalars(select(HuddleSegment).where(HuddleSegment.session_id == meeting_id)
        .order_by(HuddleSegment.created_at, HuddleSegment.user_id, HuddleSegment.sequence, HuddleSegment.segment_id)
        .offset(offset).limit(limit)))
    return {**sessions.meeting_out(meeting), 'segments': [sessions.segment_out(row) for row in rows],
            'coverage': await sessions.coverage(session, meeting_id), 'nextOffset': offset + len(rows) if len(rows) == limit else None}


@router.get('/calls/transcription')
async def transcription_config(user: Annotated[User, Depends(get_current_user)]):
    return {'engine': 'self_hosted' if settings.transcription_url and settings.transcription_token else 'browser',
            'languages': ['en-US', 'ur-PK', 'auto'] if settings.transcription_url else ['en-US', 'ur-PK'],
            'limitation': 'Speech recognition is probabilistic. Browser engines may use a different input and do not guarantee mixed-language accuracy.'}


@router.post('/calls/sessions/{meeting_id}/audio')
async def speech_chunk(meeting_id: str, session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)], channel_id: Annotated[str, Form()],
    sid: Annotated[str, Form(max_length=100)], run_id: Annotated[str, Form(min_length=1, max_length=60, pattern=r'^[a-zA-Z0-9_-]+$')],
    chunk_id: Annotated[str, Form(min_length=1, max_length=100, pattern=r'^[a-zA-Z0-9_-]+$')],
    sequence: Annotated[int, Form(ge=0, le=10000000)], start_ms: Annotated[int, Form(ge=0, le=86400000)],
    final: Annotated[bool, Form()], language: Annotated[str, Form(pattern=r'^(en-US|ur-PK|auto)$')],
    audio: Annotated[UploadFile, File()]):
    from app.calls.speech import transcribe_chunk
    data = await audio.read(512001)
    return await transcribe_chunk(session, user, channel_id=channel_id, meeting_id=meeting_id, sid=sid,
        run_id=run_id, chunk_id=chunk_id, sequence=sequence, start_ms=start_ms, final=final, language=language, audio=data)


@router.get("/calls/{channel_id}", response_model=CallSummary)
async def get_call(
    channel_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
):
    """Who is currently in a voice channel or DM call (same visibility as joining)."""
    await service.check_access(session, channel_id, user)
    return await service.summary(channel_id)
