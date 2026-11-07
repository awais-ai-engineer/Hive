"""Creating, editing and listing workflows. Only owners and admins reach these functions."""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import func, select

from app.apps.service import app_channel
from app.db.models import AppBot, AppBotChannel, Space, User, Workflow, WorkflowRun
from app.spaces.service import member_for
from app.workflows import engine
from app.workflows.schemas import WorkflowIn, WorkflowPatch

MAX_WORKFLOWS = 30
PERSON_TRIGGERS = {"member_joined", "message_keyword", "reaction_added"}


async def validate(session, space: Space, admin: User, trigger: dict, action: dict) -> None:
    """Every reference must belong to this space, and the steps must fit the trigger."""
    has_person = trigger["type"] in PERSON_TRIGGERS
    if "channelId" in trigger:
        await app_channel(session, space, trigger["channelId"], admin)
    kind = action["type"]
    if kind == "post_message":
        if action["to"] == "dm" and not has_person:
            raise HTTPException(422, "A schedule has nobody to send a direct message to. Post in a channel instead.")
        if action["to"] == "channel":
            channel = await app_channel(session, space, action["channelId"], admin)
            if action["sender"] != "hive":
                bot = await session.get(AppBot, action["sender"])
                if bot is None or bot.space_id != space.id:
                    raise HTTPException(422, "Choose one of this space's bots")
                if await session.get(AppBotChannel, (bot.id, channel.id)) is None:
                    raise HTTPException(422, f"Add {bot.name} to #{channel.name} first")
    elif kind == "create_todo":
        if action["assignee"] == "trigger":
            if not has_person:
                raise HTTPException(422, "A schedule has no person to assign to. Choose a member.")
        elif await member_for(session, space.id, action["assignee"]) is None:
            raise HTTPException(422, "Choose a member of this space")
        if action.get("channelId"):
            await app_channel(session, space, action["channelId"], admin)
    elif kind == "add_to_channel":
        if not has_person:
            raise HTTPException(422, "A schedule has no person to add to a channel")
        channel = await app_channel(session, space, action["channelId"], admin)
        if not channel.is_private:
            raise HTTPException(422, "Choose a private channel: everyone can already join public ones")


def schedule_time(workflow: Workflow) -> datetime | None:
    if workflow.trigger_type == "schedule" and workflow.enabled:
        return engine.next_run(workflow.trigger_config, datetime.now(UTC))
    return None


def split(model) -> tuple[dict, dict]:
    return model.trigger.model_dump(), model.action.model_dump()


async def out(session, workflow: Workflow) -> dict:
    last = await session.scalar(
        select(WorkflowRun).where(WorkflowRun.workflow_id == workflow.id).order_by(WorkflowRun.id.desc()).limit(1)
    )
    return {
        "id": workflow.id, "name": workflow.name, "enabled": workflow.enabled,
        "trigger": workflow.trigger_config, "action": workflow.action_config,
        "nextRunAt": workflow.next_run_at, "createdAt": workflow.created_at,
        "lastRun": {"status": last.status, "error": last.error, "at": last.created_at} if last else None,
    }


async def list_workflows(session, space: Space) -> list[dict]:
    rows = await session.scalars(select(Workflow).where(Workflow.space_id == space.id).order_by(Workflow.id))
    return [await out(session, row) for row in rows]


async def create(session, space: Space, admin: User, data: WorkflowIn) -> dict:
    count = await session.scalar(select(func.count()).select_from(Workflow).where(Workflow.space_id == space.id))
    if count >= MAX_WORKFLOWS:
        raise HTTPException(422, f"A space can have at most {MAX_WORKFLOWS} workflows")
    trigger, action = split(data)
    await validate(session, space, admin, trigger, action)
    workflow = Workflow(
        space_id=space.id, name=data.name, enabled=data.enabled, trigger_type=trigger["type"],
        trigger_config=trigger, action_type=action["type"], action_config=action, created_by=admin.id,
    )
    workflow.next_run_at = schedule_time(workflow)
    session.add(workflow)
    await session.commit()
    return await out(session, workflow)


async def own(session, space: Space, workflow_id: str) -> Workflow:
    workflow = await session.get(Workflow, workflow_id)
    if workflow is None or workflow.space_id != space.id:
        raise HTTPException(404, "Workflow not found")
    return workflow


async def update(session, space: Space, admin: User, workflow_id: str, data: WorkflowPatch) -> dict:
    workflow = await own(session, space, workflow_id)
    trigger = data.trigger.model_dump() if data.trigger else workflow.trigger_config
    action = data.action.model_dump() if data.action else workflow.action_config
    if data.trigger or data.action:
        await validate(session, space, admin, trigger, action)
        workflow.trigger_type, workflow.trigger_config = trigger["type"], trigger
        workflow.action_type, workflow.action_config = action["type"], action
        workflow.created_by = admin.id
    if data.name is not None:
        workflow.name = " ".join(data.name.split()) or workflow.name
    if data.enabled is not None:
        workflow.enabled = data.enabled
    workflow.next_run_at = schedule_time(workflow)
    await session.commit()
    return await out(session, workflow)


async def delete(session, space: Space, workflow_id: str) -> None:
    await session.delete(await own(session, space, workflow_id))
    await session.commit()


async def runs(session, space: Space, workflow_id: str) -> list[dict]:
    workflow = await own(session, space, workflow_id)
    rows = await session.scalars(
        select(WorkflowRun).where(WorkflowRun.workflow_id == workflow.id)
        .order_by(WorkflowRun.id.desc()).limit(engine.KEEP_RUNS)
    )
    names = {}
    result = []
    for run in rows:
        if run.user_id and run.user_id not in names:
            person = await session.get(User, run.user_id)
            names[run.user_id] = person.username if person else None
        result.append({
            "id": run.id, "status": run.status, "error": run.error, "detail": run.detail,
            "user": names.get(run.user_id), "at": run.created_at,
        })
    return result
