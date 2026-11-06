from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ChannelType, Doc, DocVersion, MemberRole, User, new_id
from app.docs.schemas import (
    DocCreate,
    DocOut,
    DocSave,
    DocSummary,
    PersonOut,
    VersionOut,
    VersionSummary,
)
from app.messages.service import check_not_blocked, readable
from app.spaces.permissions import require_role

KEEP_VERSIONS = 20
# Autosaves by the same person within this window update one history entry instead of adding many.
COALESCE_WINDOW = timedelta(minutes=5)


class VersionConflict(Exception):
    def __init__(self, doc: DocOut):
        self.doc = doc


async def check_write(session: AsyncSession, channel_id: str, user: User):
    """Whoever can post in the channel may edit its docs; guests and blocked people read only."""
    channel, member = await readable(session, channel_id, user.id)
    if channel.type == ChannelType.dm:
        await check_not_blocked(session, channel.id, user.id)
    else:
        require_role(member.role if member else None, MemberRole.member)
    return channel, member


async def people(session: AsyncSession, ids: set[str | None]) -> dict[str, PersonOut]:
    wanted = [item for item in ids if item]
    if not wanted:
        return {}
    users = await session.scalars(select(User).where(User.id.in_(wanted)))
    return {user.id: PersonOut.model_validate(user) for user in users}


async def serialize(session: AsyncSession, docs: list[Doc], full: bool) -> list:
    who = await people(session, {d.created_by for d in docs} | {d.updated_by for d in docs})
    out = []
    for doc in docs:
        data = {
            "id": doc.id, "channel_id": doc.channel_id, "title": doc.title, "emoji": doc.emoji,
            "version": doc.version, "created_by": who.get(doc.created_by),
            "updated_by": who.get(doc.updated_by), "created_at": doc.created_at,
            "updated_at": doc.updated_at,
        }
        out.append(DocOut(body=doc.body, **data) if full else DocSummary(**data))
    return out


async def load(
    session: AsyncSession, doc_id: str, user: User, write: bool = False, lock: bool = False
) -> Doc:
    doc = await session.scalar(select(Doc).where(Doc.id == doc_id).with_for_update(of=Doc) if lock
                               else select(Doc).where(Doc.id == doc_id))
    if doc is None:
        raise HTTPException(404, "Doc not found")
    if write:
        await check_write(session, doc.channel_id, user)
    else:
        await readable(session, doc.channel_id, user.id)
    return doc


async def list_docs(session: AsyncSession, channel_id: str, user: User) -> list[DocSummary]:
    await readable(session, channel_id, user.id)
    docs = list(await session.scalars(
        select(Doc).where(Doc.channel_id == channel_id).order_by(Doc.updated_at.desc(), Doc.id.desc())
    ))
    return await serialize(session, docs, full=False)


async def _snapshot(session: AsyncSession, doc: Doc, user_id: str, coalesce: bool) -> None:
    latest = await session.scalar(
        select(DocVersion).where(DocVersion.doc_id == doc.id).order_by(DocVersion.version.desc()).limit(1)
    )
    recent = latest is not None and latest.saved_by == user_id and (
        datetime.now(UTC) - latest.created_at < COALESCE_WINDOW
    )
    if coalesce and recent:
        latest.version = doc.version
        latest.title, latest.emoji, latest.body = doc.title, doc.emoji, doc.body
        latest.created_at = datetime.now(UTC)
    else:
        session.add(DocVersion(
            id=new_id(), doc_id=doc.id, version=doc.version, title=doc.title,
            emoji=doc.emoji, body=doc.body, saved_by=user_id,
        ))
    await session.flush()
    keep = select(DocVersion.id).where(DocVersion.doc_id == doc.id).order_by(
        DocVersion.version.desc()).limit(KEEP_VERSIONS)
    await session.execute(delete(DocVersion).where(
        DocVersion.doc_id == doc.id, DocVersion.id.not_in(keep)))


async def create_doc(session: AsyncSession, channel_id: str, data: DocCreate, user: User) -> DocOut:
    await check_write(session, channel_id, user)
    doc = Doc(
        id=new_id(), channel_id=channel_id, title=data.title, emoji=data.emoji, body=data.body,
        version=1, created_by=user.id, updated_by=user.id, updated_at=datetime.now(UTC),
    )
    session.add(doc)
    await session.flush()
    await _snapshot(session, doc, user.id, coalesce=False)
    await session.commit()
    return (await serialize(session, [doc], full=True))[0]


async def get_doc(session: AsyncSession, doc_id: str, user: User) -> DocOut:
    doc = await load(session, doc_id, user)
    return (await serialize(session, [doc], full=True))[0]


async def save_doc(session: AsyncSession, doc_id: str, data: DocSave, user: User) -> DocOut:
    doc = await load(session, doc_id, user, write=True, lock=True)
    if doc.version != data.base_version:
        raise VersionConflict((await serialize(session, [doc], full=True))[0])
    if data.title is not None:
        doc.title = data.title
    if data.clear_emoji:
        doc.emoji = None
    elif data.emoji is not None:
        doc.emoji = data.emoji
    if data.body is not None:
        doc.body = data.body
    doc.version += 1
    doc.updated_by = user.id
    doc.updated_at = datetime.now(UTC)
    await session.flush()
    await _snapshot(session, doc, user.id, coalesce=True)
    await session.commit()
    return (await serialize(session, [doc], full=True))[0]


async def delete_doc(session: AsyncSession, doc_id: str, user: User) -> Doc:
    doc = await load(session, doc_id, user)
    if doc.created_by != user.id:
        channel, member = await readable(session, doc.channel_id, user.id)
        if channel.type == ChannelType.dm:
            raise HTTPException(403, "Only the person who made this doc can delete it")
        require_role(member.role if member else None, MemberRole.admin)
    await session.delete(doc)
    await session.commit()
    return doc


async def list_versions(session: AsyncSession, doc_id: str, user: User) -> list[VersionSummary]:
    await load(session, doc_id, user)
    rows = list(await session.scalars(
        select(DocVersion).where(DocVersion.doc_id == doc_id).order_by(DocVersion.version.desc())
    ))
    who = await people(session, {row.saved_by for row in rows})
    return [VersionSummary(id=r.id, version=r.version, title=r.title, emoji=r.emoji,
                           saved_by=who.get(r.saved_by), created_at=r.created_at) for r in rows]


async def _version(session: AsyncSession, doc_id: str, version_id: str) -> DocVersion:
    row = await session.get(DocVersion, version_id)
    if row is None or row.doc_id != doc_id:
        raise HTTPException(404, "Version not found")
    return row


async def get_version(session: AsyncSession, doc_id: str, version_id: str, user: User) -> VersionOut:
    await load(session, doc_id, user)
    row = await _version(session, doc_id, version_id)
    who = await people(session, {row.saved_by})
    return VersionOut(id=row.id, version=row.version, title=row.title, emoji=row.emoji, body=row.body,
                      saved_by=who.get(row.saved_by), created_at=row.created_at)


async def restore_version(session: AsyncSession, doc_id: str, version_id: str, user: User) -> DocOut:
    doc = await load(session, doc_id, user, write=True, lock=True)
    row = await _version(session, doc_id, version_id)
    doc.title, doc.emoji, doc.body = row.title, row.emoji, row.body
    doc.version += 1
    doc.updated_by = user.id
    doc.updated_at = datetime.now(UTC)
    await session.flush()
    await _snapshot(session, doc, user.id, coalesce=False)
    await session.commit()
    return (await serialize(session, [doc], full=True))[0]
