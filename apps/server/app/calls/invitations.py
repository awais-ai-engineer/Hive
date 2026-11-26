"""Durable, row-locked calling lifecycle. Socket events are hints; snapshots recover loss."""
import json
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import or_, select, text

from app.core.config import settings
from app.db.models import Channel, HuddleInvitation, Notification, User
from app.db.session import SessionLocal, redis

PENDING = ('ringing', 'accepted', 'connecting')
TERMINAL = ('cancelled', 'declined', 'expired', 'ended')


def key(invitation_id):
    return f"{settings.socketio_channel}:call-invitation:{invitation_id}"


async def get(invitation_id):
    async with SessionLocal() as session:
        row = await session.get(HuddleInvitation, invitation_id)
        if row is None:
            raise HTTPException(404, 'Invitation not found')
        return await payload(session, row)


async def payload(session, row):
    caller = await session.get(User, row.caller_id)
    people = list(await session.scalars(select(User).where(User.id.in_(row.recipients))))
    channel = await session.get(Channel, row.channel_id)
    def person(user):
        return {'id': user.id, 'username': user.username, 'displayName': user.display_name or user.username,
                'avatarUrl': user.avatar_url}
    return {'invitationId': row.id, 'channelId': row.channel_id, 'channelName': channel.name if channel else '',
            'caller': row.caller_id, 'from': person(caller), 'recipients': row.recipients,
            'people': [person(user) for user in people], 'sid': row.caller_sid, 'declined': row.declined,
            'status': row.status, 'version': row.version, 'acceptedBy': row.accepted_by,
            'acceptedSid': row.accepted_sid, 'createdAt': row.created_at.isoformat(),
            'expiresAt': int(row.expires_at.timestamp() * 1000)}


async def emit(row):
    from app.calls.audio import optional_audio_allowed
    from app.realtime.socket import sio
    async with SessionLocal() as session:
        stored = await session.get(HuddleInvitation, row['invitationId'])
        for person in {row['caller'], *row['recipients']}:
            from app.messages.service import readable
            try:
                await readable(session, row['channelId'], person)
            except HTTPException:
                continue
            event = {**row, 'sound': await optional_audio_allowed(session, person, row['channelId'])}
            await sio.emit('call:invitation', event, room=f'user:{person}')
            if row['status'] == 'ringing':
                if person != row['caller'] and person not in row['declined']:
                    await sio.emit('call:incoming', event, room=f'user:{person}')
                elif person in row['declined']:
                    await sio.emit('call:resolved', {**event, 'status': 'declined', 'callerId': row['caller']}, room=f'user:{person}')
            elif row['status'] not in ('connecting', 'connected'):
                await sio.emit('call:resolved', {**event, 'callerId': row['caller']}, room=f'user:{person}')
        if stored and stored.status == 'expired':
            from app.notifications.service import publish
            for notification in await session.scalars(select(Notification).where(Notification.source_call_id == stored.id)):
                await publish(session, notification)
    # Compatibility cache is not authoritative, and may disappear without losing invitations.
    await redis.set(key(row['invitationId']), json.dumps(row), ex=120)


async def create(channel_id, caller, recipients, sid):
    async with SessionLocal() as session:
        await session.execute(text('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))'), {'key': f'invite:{channel_id}'})
        row = await session.scalar(select(HuddleInvitation).where(
            HuddleInvitation.channel_id == channel_id, HuddleInvitation.status.in_(PENDING),
            HuddleInvitation.expires_at > datetime.now(UTC)).order_by(HuddleInvitation.created_at).limit(1))
        if row is None:
            row = HuddleInvitation(channel_id=channel_id, caller_id=caller, caller_sid=sid,
                recipients=recipients, declined=[], expires_at=datetime.now(UTC) + timedelta(seconds=settings.call_invitation_seconds))
            session.add(row)
            await session.flush()
            for recipient in recipients:
                pair = ':'.join(sorted([caller, recipient]))
                await redis.delete(f'{settings.socketio_channel}:media-ready:{channel_id}:{pair}')
        result = await payload(session, row)
        await session.commit()
    return result


async def resolve(invitation_id, user_id, action, *, sid=None, system=False):
    async with SessionLocal() as session:
        row = await session.scalar(select(HuddleInvitation).where(HuddleInvitation.id == invitation_id).with_for_update())
        if row is None:
            raise HTTPException(404, 'Invitation not found')
        caller = user_id == row.caller_id
        if not system and ((action == 'cancelled' and not caller) or
                           (action in ('accepted', 'declined') and user_id not in row.recipients)):
            raise HTTPException(403, 'This invitation is not yours')
        if row.status in TERMINAL or row.status == 'connected':
            return await payload(session, row)
        if action == 'accepted' and row.accepted_sid:
            if row.accepted_sid != sid:
                raise HTTPException(409, 'This invitation was answered on another device')
            return await payload(session, row)
        if datetime.now(UTC) >= row.expires_at:
            action = 'expired' if row.status == 'ringing' else 'ended'
        if action == 'declined' and user_id in row.declined:
            return await payload(session, row)
        if action == 'accepted':
            from app.availability.service import enforce
            from app.calls.service import check_access
            user = await session.get(User, user_id)
            await check_access(session, row.channel_id, user, direct_contact=False)
            await enforce(session, row.channel_id, row.caller_id, 'huddles')
            row.accepted_by = user_id
            row.accepted_sid = sid
            row.expires_at = datetime.now(UTC) + timedelta(seconds=45)
            row.status = 'accepted'
        elif action == 'declined' and row.status == 'ringing':
            row.declined = [*row.declined, user_id]
            if set(row.declined) == set(row.recipients):
                row.status = 'declined'
        else:
            row.status = action
        if row.status in TERMINAL:
            row.ended_at = datetime.now(UTC)
        row.version += 1
        if row.status == 'expired':
            from app.notifications.service import _permitted
            for person in set(row.recipients) - set(row.declined):
                if await _permitted(session, person, 'missed_huddle', row.caller_id, channel_id=row.channel_id):
                    session.add(Notification(user_id=person, actor_id=row.caller_id, type='missed_huddle',
                        channel_id=row.channel_id, source_call_id=row.id,
                        snippet=f'Missed Huddle invited at {row.created_at.isoformat()}'))
        result = await payload(session, row)
        await session.commit()
    await emit(result)
    return result


async def accept_for(channel_id, user_id, sid=None):
    # A legacy direct join may accept a ringing invitation; explicit accepts reserve a device.
    async with SessionLocal() as session:
        rows = list(await session.scalars(select(HuddleInvitation).where(
            HuddleInvitation.channel_id == channel_id, HuddleInvitation.recipients.contains([user_id]),
            HuddleInvitation.status.in_(PENDING))))
    for row in rows:
        if row.status == 'ringing' and user_id not in row.declined:
            await resolve(row.id, user_id, 'accepted', sid=sid)
        async with SessionLocal() as session:
            stored = await session.get(HuddleInvitation, row.id, with_for_update=True)
            if stored.status == 'accepted' and stored.accepted_by == user_id and (not stored.accepted_sid or stored.accepted_sid == sid):
                stored.status = 'connecting'; stored.version += 1
                result = await payload(session, stored)
                await session.commit()
                await emit(result)


async def snapshot(session, user_id, history=False):
    await expire_or_cancel()
    query = select(HuddleInvitation).where(or_(HuddleInvitation.caller_id == user_id,
                                              HuddleInvitation.recipients.contains([user_id])))
    if not history:
        query = query.where(HuddleInvitation.status.in_((*PENDING, 'connected')))
    rows = list(await session.scalars(query.order_by(HuddleInvitation.created_at.desc()).limit(100)))
    result = []
    from app.calls.audio import optional_audio_allowed
    from app.messages.service import readable
    for row in rows:
        try:
            await readable(session, row.channel_id, user_id)
        except HTTPException:
            continue
        result.append({**await payload(session, row), 'sound': await optional_audio_allowed(session, user_id, row.channel_id)})
    return result


async def expire_or_cancel(sid=None, channel_id=None):
    async with SessionLocal() as session:
        query = select(HuddleInvitation).where(HuddleInvitation.status.in_(PENDING))
        if sid:
            query = query.where(HuddleInvitation.caller_sid == sid)
            if channel_id:
                query = query.where(HuddleInvitation.channel_id == channel_id)
        else:
            query = query.where(HuddleInvitation.expires_at <= datetime.now(UTC))
        rows = list(await session.scalars(query.order_by(HuddleInvitation.expires_at).limit(100)))
    for row in rows:
        await resolve(row.id, row.caller_id, 'cancelled' if sid else 'expired', system=True)


async def media_ready(channel_id, user_id, peer_id):
    from app.calls.service import participants
    room = await participants(channel_id)
    people = {entry['userId'] for entry in room.values()}
    if user_id not in people or peer_id not in people or user_id == peer_id:
        raise HTTPException(403, 'Both media peers must be present')
    pair = ':'.join(sorted([user_id, peer_id]))
    media_key = f'{settings.socketio_channel}:media-ready:{channel_id}:{pair}'
    await redis.sadd(media_key, user_id)
    await redis.expire(media_key, 120)
    if set(await redis.smembers(media_key)) != {user_id, peer_id}:
        return
    async with SessionLocal() as session:
        rows = list(await session.scalars(select(HuddleInvitation).where(
            HuddleInvitation.channel_id == channel_id, HuddleInvitation.status.in_(('accepted', 'connecting')),
            HuddleInvitation.caller_id.in_([user_id, peer_id]), HuddleInvitation.accepted_by.in_([user_id, peer_id])).with_for_update()))
        events = []
        for row in rows:
            row.status = 'connected'; row.connected_at = datetime.now(UTC); row.version += 1
            events.append(await payload(session, row))
        await session.commit()
    for event in events:
        await emit(event)


async def ended(channel_id, user_id):
    async with SessionLocal() as session:
        rows = list(await session.scalars(select(HuddleInvitation).where(
            HuddleInvitation.channel_id == channel_id, HuddleInvitation.status == 'connected',
            or_(HuddleInvitation.caller_id == user_id, HuddleInvitation.accepted_by == user_id)).with_for_update()))
        events = []
        for row in rows:
            row.status = 'ended'; row.ended_at = datetime.now(UTC); row.version += 1
            events.append(await payload(session, row))
        await session.commit()
    for event in events:
        await emit(event)


async def finish_channel(channel_id, ended_at):
    """Reconcile connected calls after the last disconnected device exhausts its grace period."""
    async with SessionLocal() as session:
        rows = list(await session.scalars(select(HuddleInvitation).where(
            HuddleInvitation.channel_id == channel_id,
            HuddleInvitation.status.in_(('accepted', 'connecting', 'connected')),
            HuddleInvitation.created_at <= ended_at).with_for_update()))
        events = []
        for row in rows:
            row.status = 'ended'; row.ended_at = ended_at; row.version += 1
            events.append(await payload(session, row))
        await session.commit()
    for event in events:
        await emit(event)
