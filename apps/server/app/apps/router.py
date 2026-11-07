from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.apps import service
from app.apps.schemas import (
    BotIn,
    BotMessageIn,
    BotPatch,
    CommandIn,
    CommandRun,
    HookIn,
    WebhookIn,
    WebhookPatch,
)
from app.auth.deps import get_current_user
from app.db.models import AppBot, User
from app.db.session import get_session
from app.realtime.socket import broadcast_message, sio
from app.spaces.service import load_space

# Managing apps: owners and admins of the space.
router = APIRouter(prefix="/spaces/{slug}", tags=["apps"])
# Called by outside programs with their own secret instead of a login.
public_router = APIRouter(tags=["apps"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


async def admin(slug: str, session: Session, user: CurrentUser):
    return await service.admin_space(session, slug, user)


Admin = Annotated[object, Depends(admin)]


@router.get("/webhooks")
async def get_webhooks(space: Admin, session: Session):
    return await service.list_webhooks(session, space)


@router.post("/webhooks", status_code=201)
async def post_webhook(data: WebhookIn, space: Admin, session: Session, user: CurrentUser):
    return await service.create_webhook(session, space, user, data)


@router.patch("/webhooks/{hook_id}")
async def patch_webhook(hook_id: str, data: WebhookPatch, space: Admin, session: Session, user: CurrentUser):
    return await service.update_webhook(session, space, user, hook_id, data)


@router.post("/webhooks/{hook_id}/regenerate")
async def regenerate_webhook(hook_id: str, space: Admin, session: Session):
    return await service.regenerate_webhook(session, space, hook_id)


@router.delete("/webhooks/{hook_id}", status_code=204)
async def remove_webhook(hook_id: str, space: Admin, session: Session):
    await service.delete_webhook(session, space, hook_id)
    return Response(status_code=204)


@router.get("/bots")
async def get_bots(space: Admin, session: Session, user: CurrentUser):
    return await service.list_bots(session, space, user)


@router.post("/bots", status_code=201)
async def post_bot(data: BotIn, space: Admin, session: Session, user: CurrentUser):
    return await service.create_bot(session, space, user, data)


@router.patch("/bots/{bot_id}")
async def patch_bot(bot_id: str, data: BotPatch, space: Admin, session: Session, user: CurrentUser):
    return await service.update_bot(session, space, user, bot_id, data)


@router.post("/bots/{bot_id}/regenerate")
async def regenerate_bot(bot_id: str, space: Admin, session: Session, user: CurrentUser):
    return await service.regenerate_bot(session, space, user, bot_id)


@router.post("/bots/{bot_id}/rotate-secret")
async def rotate_secret(bot_id: str, space: Admin, session: Session, user: CurrentUser):
    return await service.rotate_secret(session, space, user, bot_id)


@router.get("/bots/{bot_id}/deliveries")
async def get_deliveries(bot_id: str, space: Admin, session: Session):
    return await service.recent_deliveries(session, space, bot_id)


@router.delete("/bots/{bot_id}", status_code=204)
async def remove_bot(bot_id: str, space: Admin, session: Session):
    await service.delete_bot(session, space, bot_id)
    return Response(status_code=204)


@router.get("/commands")
async def get_commands(slug: str, session: Session, user: CurrentUser):
    """Custom slash commands: every member of the space may see what exists."""
    space, member = await load_space(session, slug, user)
    if member is None:
        raise HTTPException(403, "Join this space to see its commands")
    return await service.list_commands(session, space.id)


@router.post("/commands", status_code=201)
async def post_command(data: CommandIn, space: Admin, session: Session, user: CurrentUser):
    return await service.create_command(session, space, user, data)


@router.delete("/commands/{command_id}", status_code=204)
async def remove_command(command_id: str, space: Admin, session: Session):
    await service.delete_command(session, space, command_id)
    return Response(status_code=204)


# ---------- composer ----------

@public_router.get("/channels/{channel_id}/commands")
async def channel_commands(channel_id: str, session: Session, user: CurrentUser):
    return await service.commands_for_channel(session, channel_id, user)


@public_router.post("/channels/{channel_id}/commands/run")
async def run_command(channel_id: str, data: CommandRun, session: Session, user: CurrentUser):
    text, ephemeral, bot = await service.run_command(session, user, channel_id, data)
    if ephemeral:
        event = {"channelId": channel_id, "command": data.command.lstrip("/").lower(), "text": text,
                 "botName": bot.name, "botEmoji": bot.emoji, "parentId": data.parentId}
        await sio.emit("command:response", event, room=f"user:{user.id}")
        return {"ephemeral": True, **event}
    message, inserted, parent, identity = await service.post_command_answer(
        session, bot, channel_id, text, data.parentId
    )
    if inserted:
        await broadcast_message(session, identity, message, parent, source="app")
    return {"ephemeral": False, "channelId": channel_id, "message": message}


# ---------- incoming webhooks ----------

@public_router.post("/hooks/{token}", status_code=201)
async def incoming_hook(token: str, data: HookIn, session: Session):
    message, inserted, parent, identity = await service.post_from_webhook(session, token, data)
    if inserted:
        await broadcast_message(session, identity, message, parent, source="app")
    return {"ok": True, "id": message["id"]}


# ---------- bot API ----------

async def current_bot(
    session: Session, authorization: Annotated[str | None, Header()] = None
) -> AppBot:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "Send the bot token as 'Authorization: Bearer <token>'",
                            headers={"WWW-Authenticate": "Bearer"})
    return await service.authenticate_bot(session, token.strip())


CurrentBot = Annotated[AppBot, Depends(current_bot)]


@public_router.post("/bot/messages", status_code=201)
async def bot_message(data: BotMessageIn, bot: CurrentBot, session: Session):
    message, inserted, parent, identity = await service.bot_post(session, bot, data)
    if inserted:
        await broadcast_message(session, identity, message, parent, source="app")
    return message


@public_router.get("/bot/channels")
async def bot_channels(bot: CurrentBot, session: Session):
    return await service.bot_channel_list(session, bot)


@public_router.get("/bot/channels/{channel_id}/messages")
async def bot_messages(
    channel_id: str, bot: CurrentBot, session: Session,
    before: str | None = None, limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    return await service.bot_history(session, bot, channel_id, before, limit)
