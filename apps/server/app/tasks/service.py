from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Channel,
    ChannelMember,
    ChannelType,
    DirectMember,
    MemberRole,
    Message,
    SpaceMember,
    Task,
    User,
    new_id,
)
from app.docs.schemas import PersonOut
from app.docs.service import check_write, people, read_channel
from app.messages.service import readable
from app.messages.threads import my_channel_ids, places
from app.spaces.permissions import require_role
from app.tasks.schemas import TaskCreate, TaskOut, TaskPatch

LIMIT = 300


async def can_read(session: AsyncSession, channel_id: str, user_id: str) -> bool:
    try:
        await readable(session, channel_id, user_id)
    except HTTPException:
        return False
    return True


async def serialize(session: AsyncSession, tasks: list[Task], viewer: User) -> list[TaskOut]:
    who = await people(session, {t.created_by for t in tasks} | {t.assignee_id for t in tasks})
    where = await places(session, viewer.id, list({t.channel_id for t in tasks if t.channel_id}))
    return [
        TaskOut(
            id=t.id, title=t.title, notes=t.notes, status=t.status, priority=t.priority, due_at=t.due_at,
            completed_at=t.completed_at, created_by=who.get(t.created_by),
            assignee=who.get(t.assignee_id) if t.assignee_id else None, channel_id=t.channel_id,
            place=where.get(t.channel_id), source_message_id=t.source_message_id,
            position=t.position, created_at=t.created_at, updated_at=t.updated_at,
        )
        for t in tasks
    ]


async def _check_assignee(session: AsyncSession, channel_id: str | None, user: User, assignee_id: str):
    if channel_id is None:
        if assignee_id != user.id:
            raise HTTPException(422, "Personal to-dos can only be assigned to yourself")
        return
    if await session.get(User, assignee_id) is None or not await can_read(session, channel_id, assignee_id):
        raise HTTPException(422, "That person cannot see this conversation")


async def _visible(session: AsyncSession, task: Task, user: User) -> None:
    """404 unless the viewer may see the task (channel tasks follow the channel's read rule)."""
    if task.channel_id is None:
        if user.id not in (task.created_by, task.assignee_id):
            raise HTTPException(404, "To-do not found")
    elif not await can_read(session, task.channel_id, user.id):
        raise HTTPException(404, "To-do not found")


async def load(session: AsyncSession, task_id: str, user: User) -> Task:
    task = await session.get(Task, task_id)
    if task is None:
        raise HTTPException(404, "To-do not found")
    await _visible(session, task, user)
    return task


async def create_task(session: AsyncSession, data: TaskCreate, user: User) -> Task:
    if data.channel_id is not None:
        await check_write(session, data.channel_id, user)
    if data.source_message_id is not None:
        message = await session.get(Message, data.source_message_id)
        if data.channel_id is None or message is None or message.channel_id != data.channel_id:
            raise HTTPException(422, "That message is not in this conversation")
    if data.assignee_id is not None:
        await _check_assignee(session, data.channel_id, user, data.assignee_id)
    task = Task(
        id=new_id(), title=data.title, notes=data.notes, created_by=user.id,
        assignee_id=data.assignee_id, channel_id=data.channel_id,
        source_message_id=data.source_message_id, due_at=data.due_at, status="open", priority=data.priority,
        updated_at=datetime.now(UTC),
    )
    session.add(task)
    await session.commit()
    return task


async def update_task(
    session: AsyncSession, task_id: str, data: TaskPatch, user: User
) -> tuple[Task, str | None]:
    """Returns the task and the previous assignee (who also needs to hear about the change)."""
    task = await load(session, task_id, user)
    if task.channel_id is not None:
        await check_write(session, task.channel_id, user)
    previous = task.assignee_id
    fields = data.model_fields_set
    if "assignee_id" in fields:
        if data.assignee_id is not None:
            await _check_assignee(session, task.channel_id, user, data.assignee_id)
        task.assignee_id = data.assignee_id
    if "due_at" in fields:
        task.due_at = data.due_at
    if data.title is not None:
        task.title = data.title
    if data.notes is not None:
        task.notes = data.notes
    if "priority" in fields:
        task.priority = data.priority
    if data.status is not None and data.status != task.status:
        task.status = data.status
        task.completed_at = datetime.now(UTC) if data.status == "done" else None
    task.updated_at = datetime.now(UTC)
    await session.commit()
    return task, previous


async def delete_task(session: AsyncSession, task_id: str, user: User) -> Task:
    task = await load(session, task_id, user)
    if task.created_by != user.id:
        if task.channel_id is None:
            raise HTTPException(403, "Only the person who made this to-do can delete it")
        channel, member = await read_channel(session, task.channel_id, user.id)
        if channel.type == ChannelType.dm:
            raise HTTPException(403, "Only the person who made this to-do can delete it")
        require_role(member.role if member else None, MemberRole.admin)
    await session.delete(task)
    await session.commit()
    return task


def _yours(user: User):
    """Assigned to you, or yours with nobody else assigned."""
    return or_(Task.assignee_id == user.id, and_(Task.created_by == user.id, Task.assignee_id.is_(None)))


def _in_reach(user: User):
    """Personal tasks, or tasks of channels the user still belongs to."""
    return or_(Task.channel_id.is_(None), Task.channel_id.in_(select(my_channel_ids(user.id).c.id)))


async def list_tasks(
    session: AsyncSession, user: User, scope: str, channel_id: str | None
) -> list[Task]:
    query = select(Task)
    if scope == "channel":
        if channel_id is None:
            raise HTTPException(422, "channel_id is required for this scope")
        await read_channel(session, channel_id, user.id)
        query = query.where(Task.channel_id == channel_id)
    elif scope == "mine":
        query = query.where(Task.status != "done", _yours(user), _in_reach(user))
    elif scope == "assigned_by_me":
        query = query.where(
            Task.status != "done", Task.created_by == user.id, Task.assignee_id.is_not(None),
            Task.assignee_id != user.id, _in_reach(user))
    elif scope == "done":
        query = query.where(
            Task.status == "done", or_(Task.assignee_id == user.id, Task.created_by == user.id),
            _in_reach(user))
    else:
        raise HTTPException(422, "Unknown scope")
    if scope == "done":
        order = [Task.completed_at.desc().nulls_last(), Task.id.desc()]
    else:
        order = [Task.status.desc(), Task.due_at.asc().nulls_last(), Task.id]
    return list(await session.scalars(query.order_by(*order).limit(LIMIT)))


async def due_count(session: AsyncSession, user: User, until: datetime) -> int:
    return await session.scalar(
        select(func.count()).select_from(Task).where(
            Task.status != "done", _yours(user), _in_reach(user),
            Task.due_at.is_not(None), Task.due_at <= until)
    ) or 0


async def assignable(session: AsyncSession, channel_id: str | None, user: User) -> list[PersonOut]:
    """People who can read the conversation (just you for personal to-dos)."""
    if channel_id is None:
        return [PersonOut.model_validate(user)]
    channel, _ = await read_channel(session, channel_id, user.id)
    return await _readers(session, channel)


async def _readers(session: AsyncSession, channel: Channel) -> list[PersonOut]:
    if channel.type == ChannelType.dm:
        ids = select(DirectMember.user_id).where(DirectMember.channel_id == channel.id)
    else:
        ids = select(SpaceMember.user_id).where(
            SpaceMember.space_id == channel.space_id,
            or_(SpaceMember.banned_until.is_(None), SpaceMember.banned_until <= datetime.now(UTC)),
        )
        if channel.is_private:
            ids = ids.where(SpaceMember.user_id.in_(
                select(ChannelMember.user_id).where(ChannelMember.channel_id == channel.id)))
    users = await session.scalars(
        select(User).where(User.id.in_(ids)).order_by(User.username).limit(200))
    return [PersonOut.model_validate(u) for u in users]
