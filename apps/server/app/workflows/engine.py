"""Runs workflows: matches triggers, performs the action once, and keeps a short history.

Loop protection: messages a workflow posts never start workflows (broadcast_message is told
their source), and one workflow runs at most 20 times per minute.
"""

import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from app.db.models import (
    AppBot,
    AppBotChannel,
    Channel,
    ChannelMember,
    ChannelType,
    MemberRole,
    Message,
    Space,
    Task,
    User,
    Workflow,
    WorkflowRun,
)
from app.db.session import SessionLocal
from app.messages.composer import CHANNEL_TOKEN, TOKEN
from app.messages.schemas import SendIn
from app.messages.service import send
from app.spaces.permissions import ROLE_RANK
from app.spaces.service import member_for

log = logging.getLogger("hive.workflows")

MAX_RUNS_PER_MINUTE = 20
KEEP_RUNS = 50
VARIABLE = re.compile(r"\{(user|channel|date|message)\}")


@dataclass
class Context:
    space: Space
    user: User | None = None
    channel: Channel | None = None
    message_id: str | None = None
    snippet: str = ""
    timezone: str = "UTC"


# ---------- schedule ----------

def next_run(trigger: dict, after: datetime) -> datetime:
    """The first moment strictly after `after` that matches a schedule (DST-safe)."""
    zone = ZoneInfo(trigger.get("timezone") or "UTC")
    hour, minute = (int(part) for part in trigger["time"].split(":"))
    day = after.astimezone(zone).date()
    for offset in range(9):
        date = day + timedelta(days=offset)
        if trigger["frequency"] == "weekly" and date.weekday() != trigger.get("weekday"):
            continue
        moment = datetime.combine(date, time(hour, minute), tzinfo=zone).astimezone(UTC)
        if moment > after:
            return moment
    raise ValueError("Invalid schedule")


# ---------- text ----------

def plain(text: str) -> str:
    """Message text with mention and channel tokens flattened, safe to paste into new text."""
    text = TOKEN.sub("@someone", text)
    return CHANNEL_TOKEN.sub("#channel", text)


def render(text: str, ctx: Context, *, rich: bool, target: Channel | None = None) -> str:
    """Fills {user}, {channel}, {date} (and {message}). One pass, so values are never re-expanded."""
    now = datetime.now(ZoneInfo(ctx.timezone))
    channel = ctx.channel or target
    if ctx.user is None:
        user = "everyone"
    elif rich:
        user = f"@[user:{ctx.user.id}]"
    else:
        user = ctx.user.username
    if channel is None:
        chan = ""
    elif rich:
        chan = f"#[channel:{channel.id}]"
    else:
        chan = f"#{channel.name}"
    values = {
        "user": user,
        "channel": chan,
        "date": f"{now:%A}, {now:%B} {now.day}, {now.year}",
        "message": plain(ctx.snippet)[:120],
    }
    return VARIABLE.sub(lambda match: values[match.group(1)], text)


# ---------- actions ----------

async def _sender(session, space: Space, sender: str, channel: Channel | None):
    from app.scheduler import system_user

    if sender == "hive":
        return await system_user(session)
    bot = await session.get(AppBot, sender)
    if bot is None or bot.space_id != space.id:
        raise HTTPException(422, "The bot chosen for this workflow no longer exists")
    if channel is not None and await session.get(AppBotChannel, (bot.id, channel.id)) is None:
        raise HTTPException(422, f"{bot.name} has not been added to #{channel.name}")
    return await session.get(User, bot.bot_user_id)


def _need_person(ctx: Context) -> User:
    if ctx.user is None:
        raise HTTPException(422, "This step needs a person, but the trigger has none")
    if ctx.user.is_bot or ctx.user.is_system:
        raise HTTPException(422, "The trigger was caused by an app, not a person")
    return ctx.user


async def _post_message(session, wf: Workflow, ctx: Context, after: list):
    from app.scheduler import reminder_conversation, system_user

    config = wf.action_config
    if config["to"] == "dm":
        person = _need_person(ctx)
        sender = await system_user(session)
        channel = await reminder_conversation(session, person.id)
        text = render(config["text"], ctx, rich=False)
    else:
        channel = await session.get(Channel, config["channelId"])
        if channel is None or channel.space_id != wf.space_id or channel.type != ChannelType.text:
            raise HTTPException(422, "The channel for this message no longer exists")
        sender = await _sender(session, ctx.space, config.get("sender", "hive"), channel)
        text = render(config["text"], ctx, rich=True, target=channel)
    message, inserted, parent = await send(
        session, sender,
        SendIn(channelId=channel.id, body=text[:4000] or "(empty)", clientMsgId=str(uuid4())),
        commit=False, trusted=True,
    )
    if inserted:
        after.append((sender, message, parent))
    return f"Posted in {'a direct message' if config['to'] == 'dm' else '#' + channel.name}"


async def _create_todo(session, wf: Workflow, ctx: Context, after: list):
    from app.scheduler import system_user
    from app.tasks.service import can_read

    config = wf.action_config
    if config.get("assignee", "trigger") == "trigger":
        assignee = _need_person(ctx)
    else:
        assignee = await session.get(User, config["assignee"])
        if assignee is None or await member_for(session, wf.space_id, assignee.id) is None:
            raise HTTPException(422, "The person chosen for this to-do is no longer in the space")
    channel_id = config.get("channelId")
    source = None
    if channel_id is None and ctx.channel is not None and ctx.message_id is not None:
        channel_id, source = ctx.channel.id, ctx.message_id
    if channel_id is not None:
        channel = await session.get(Channel, channel_id)
        if channel is None or channel.space_id != wf.space_id:
            raise HTTPException(422, "The channel for this to-do no longer exists")
        if not await can_read(session, channel_id, assignee.id):
            raise HTTPException(422, f"{assignee.username} cannot see #{channel.name}")
    title = render(config["title"], ctx, rich=False)[:200].strip() or "Follow up"
    creator = (await system_user(session)).id if channel_id else assignee.id
    task = Task(
        title=title, created_by=creator, assignee_id=assignee.id, channel_id=channel_id,
        source_message_id=source, status="open", updated_at=datetime.now(UTC),
    )
    session.add(task)
    await session.flush()
    after.append(("task", task))
    return f"To-do for {assignee.username}: {title}"


async def _add_to_channel(session, wf: Workflow, ctx: Context, after: list):
    person = _need_person(ctx)
    owner = await member_for(session, wf.space_id, wf.created_by)
    if owner is None or ROLE_RANK[owner.role] < ROLE_RANK[MemberRole.admin]:
        raise HTTPException(422, "Only a space admin's workflow can add people to private channels")
    channel = await session.get(Channel, wf.action_config["channelId"])
    if channel is None or channel.space_id != wf.space_id or not channel.is_private:
        raise HTTPException(422, "The private channel for this step no longer exists")
    if await member_for(session, wf.space_id, person.id) is None:
        raise HTTPException(422, f"{person.username} is not a member of the space")
    await session.execute(
        insert(ChannelMember).values(channel_id=channel.id, user_id=person.id).on_conflict_do_nothing()
    )
    after.append(("added", person.id, wf.space_id))
    return f"Added {person.username} to #{channel.name}"


ACTIONS = {
    "post_message": _post_message,
    "create_todo": _create_todo,
    "add_to_channel": _add_to_channel,
}


# ---------- running ----------

async def _record(session, workflow_id: str, status: str, user_id: str | None, detail=None, error=None):
    session.add(WorkflowRun(
        workflow_id=workflow_id, status=status, user_id=user_id,
        detail=(detail or None) and detail[:300], error=(error or None) and error[:300],
    ))
    await session.flush()
    newest = select(WorkflowRun.id).where(WorkflowRun.workflow_id == workflow_id).order_by(
        WorkflowRun.id.desc()).limit(KEEP_RUNS)
    await session.execute(delete(WorkflowRun).where(
        WorkflowRun.workflow_id == workflow_id, WorkflowRun.id.not_in(newest)))


async def run(workflow_id: str, *, user_id: str | None = None, channel_id: str | None = None,
              message_id: str | None = None, snippet: str = "") -> str | None:
    """Runs one workflow for one event. Returns the run status, or None if it was not eligible."""
    after: list = []
    async with SessionLocal() as session:
        wf = await session.scalar(select(Workflow).where(Workflow.id == workflow_id).with_for_update())
        if wf is None or not wf.enabled:
            return None
        recent = await session.scalar(
            select(func.count()).select_from(WorkflowRun).where(
                WorkflowRun.workflow_id == wf.id, WorkflowRun.status != "skipped",
                WorkflowRun.created_at > func.now() - timedelta(seconds=60))
        )
        if recent >= MAX_RUNS_PER_MINUTE:
            await _record(session, wf.id, "skipped", user_id,
                          error="Paused for a minute: this workflow ran 20 times in the last minute")
            await session.commit()
            return "skipped"
        space = await session.get(Space, wf.space_id)
        ctx = Context(space=space, message_id=message_id, snippet=snippet)
        if wf.trigger_type == "schedule":
            ctx.timezone = wf.trigger_config.get("timezone", "UTC")
        if user_id:
            ctx.user = await session.get(User, user_id)
        if channel_id:
            ctx.channel = await session.get(Channel, channel_id)
        status, detail, error = "ok", None, None
        try:
            detail = await ACTIONS[wf.action_type](session, wf, ctx, after)
        except HTTPException as exc:
            status, error = "error", str(exc.detail)
        except Exception as exc:  # a broken workflow must never break the app
            log.exception("workflow %s failed", wf.id)
            status, error = "error", f"Unexpected error: {type(exc).__name__}"
        if status == "error":
            await session.rollback()
            after.clear()
        await _record(session, workflow_id, status, user_id, detail, error)
        await session.commit()
    if status == "ok":
        await _after_commit(after)
    return status


async def _after_commit(after: list) -> None:
    from app.realtime.socket import broadcast_message, sio

    for item in after:
        try:
            if item[0] == "task":
                from app.tasks.router import announce

                async with SessionLocal() as session:
                    task = await session.get(Task, item[1].id)
                    await announce(session, "created", task)
            elif item[0] == "added":
                await sio.emit("space:activity", {"spaceId": item[2]}, room=f"user:{item[1]}")
            else:
                sender, message, parent = item
                async with SessionLocal() as session:
                    await broadcast_message(session, sender, message, parent, source="workflow")
        except Exception:
            log.exception("workflow follow-up failed")


# ---------- triggers ----------

async def _matching(trigger_type: str, space_id: str | None = None) -> list[Workflow]:
    async with SessionLocal() as session:
        query = select(Workflow).where(Workflow.enabled.is_(True), Workflow.trigger_type == trigger_type)
        if space_id is not None:
            query = query.where(Workflow.space_id == space_id)
        return list(await session.scalars(query.order_by(Workflow.id)))


async def _safely(workflow_id: str, **event) -> None:
    try:
        await run(workflow_id, **event)
    except Exception:
        log.exception("workflow %s could not run", workflow_id)


async def on_member_joined(space_id: str, user_id: str) -> None:
    for workflow in await _matching("member_joined", space_id):
        await _safely(workflow.id, user_id=user_id)


async def on_message(message: dict) -> None:
    """Called for every new chat message except those posted by workflows."""
    body = message.get("body") or ""
    author = message["author"]
    if not body:
        return
    async with SessionLocal() as session:
        channel = await session.get(Channel, message["channel_id"])
        person = await session.get(User, author["id"])
    if channel is None or channel.space_id is None or person is None or person.is_system:
        return
    folded = body.casefold()
    for workflow in await _matching("message_keyword", channel.space_id):
        config = workflow.trigger_config
        if config.get("channelId") == channel.id and config["keyword"].casefold() in folded:
            await _safely(workflow.id, user_id=author["id"], channel_id=channel.id,
                          message_id=message["id"], snippet=body)


async def on_reaction(channel_id: str, message_id: str, user_id: str, emoji: str) -> None:
    async with SessionLocal() as session:
        channel = await session.get(Channel, channel_id)
        message = await session.get(Message, message_id)
    if channel is None or channel.space_id is None or message is None:
        return
    for workflow in await _matching("reaction_added", channel.space_id):
        config = workflow.trigger_config
        if config.get("channelId") == channel_id and config.get("emoji") == emoji:
            await _safely(workflow.id, user_id=user_id, channel_id=channel_id,
                          message_id=message_id, snippet=message.body or "")


async def run_scheduled(now: datetime | None = None) -> int:
    """Starts every schedule that is due. Each one is claimed (and moved to its next time) first,
    so a crash or a second worker can never fire the same moment twice."""
    now = now or datetime.now(UTC)
    started = 0
    for _ in range(100):
        async with SessionLocal() as session:
            wf = await session.scalar(
                select(Workflow).where(
                    Workflow.enabled.is_(True), Workflow.trigger_type == "schedule",
                    Workflow.next_run_at.is_not(None), Workflow.next_run_at <= now)
                .order_by(Workflow.next_run_at).limit(1).with_for_update(skip_locked=True)
            )
            if wf is None:
                break
            workflow_id = wf.id
            wf.next_run_at = next_run(wf.trigger_config, now)
            await session.commit()
        await _safely(workflow_id)
        started += 1
    return started
