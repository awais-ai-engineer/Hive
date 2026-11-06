from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import Channel, Task, User
from app.db.session import get_session
from app.docs.schemas import PersonOut
from app.realtime.socket import call_audience, sio
from app.tasks import service
from app.tasks.schemas import TaskCreate, TaskOut, TaskPatch, TaskSummary

router = APIRouter(prefix="/tasks", tags=["tasks"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


async def announce(
    session: AsyncSession, action: str, task: Task, extra: tuple[str | None, ...] = ()
) -> None:
    """Tell the creator and assignee (while they can still see it) and, for channel to-dos, the
    people who can read that channel. This keeps rail badges and open lists fresh."""
    event = {"action": action, "taskId": task.id, "channelId": task.channel_id,
             "assigneeId": task.assignee_id, "createdBy": task.created_by}
    rooms: list[str] = []
    for person in dict.fromkeys([task.created_by, task.assignee_id, *extra]):
        if person and (task.channel_id is None or await service.can_read(session, task.channel_id, person)):
            rooms.append(f"user:{person}")
    if task.channel_id is not None:
        channel = await session.get(Channel, task.channel_id)
        if channel is not None:
            rooms.extend(await call_audience(session, channel))
    for room in dict.fromkeys(rooms):
        await sio.emit("task:updated", event, room=room)


@router.get("", response_model=list[TaskOut])
async def get_tasks(
    session: Session,
    user: CurrentUser,
    scope: Literal["mine", "assigned_by_me", "done", "channel"] = "mine",
    channel_id: str | None = None,
):
    tasks = await service.list_tasks(session, user, scope, channel_id)
    return await service.serialize(session, tasks, user)


@router.get("/summary", response_model=TaskSummary)
async def get_summary(
    session: Session, user: CurrentUser, until: Annotated[datetime | None, Query()] = None
):
    """Badge count: your open to-dos due by `until` (default: now)."""
    until = until or datetime.now(UTC)
    if until.tzinfo is None:
        until = until.replace(tzinfo=UTC)
    return TaskSummary(due_count=await service.due_count(session, user, until))


@router.get("/assignees", response_model=list[PersonOut])
async def get_assignees(session: Session, user: CurrentUser, channel_id: str | None = None):
    return await service.assignable(session, channel_id, user)


@router.post("", response_model=TaskOut, status_code=201)
async def post_task(data: TaskCreate, session: Session, user: CurrentUser):
    task = await service.create_task(session, data, user)
    await announce(session, "created", task)
    return (await service.serialize(session, [task], user))[0]


@router.patch("/{task_id}", response_model=TaskOut)
async def patch_task(task_id: str, data: TaskPatch, session: Session, user: CurrentUser):
    task, previous = await service.update_task(session, task_id, data, user)
    await announce(session, "updated", task, (previous,))
    return (await service.serialize(session, [task], user))[0]


@router.delete("/{task_id}", status_code=204)
async def remove_task(task_id: str, session: Session, user: CurrentUser):
    task = await service.delete_task(session, task_id, user)
    await announce(session, "deleted", task)
