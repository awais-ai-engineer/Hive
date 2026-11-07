"""Webhooks, bots and custom slash commands of a space."""

from datetime import UTC, datetime
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from app.apps import delivery, tokens
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
from app.db.models import (
    AppBot,
    AppBotChannel,
    AppCommand,
    AppDelivery,
    AppWebhook,
    Channel,
    ChannelType,
    MemberRole,
    Message,
    Space,
    User,
)
from app.db.session import redis
from app.messages.schemas import SendIn
from app.messages.service import _with_authors, readable, send, serialize, writable
from app.spaces.permissions import require_role
from app.spaces.service import load_space

MAX_WEBHOOKS = 25
MAX_BOTS = 10
MAX_COMMANDS = 25
HOOK_PER_MINUTE = 30
BOT_PER_MINUTE = 60


async def admin_space(session, slug: str, user: User) -> Space:
    """Owners and admins only. Outsiders of a private space get a 404 like everywhere else."""
    space, member = await load_space(session, slug, user)
    require_role(member.role if member else None, MemberRole.admin)
    return space


async def rate_limit(key: str, limit: int, seconds: int = 60) -> None:
    count = await redis.eval(
        "local n = redis.call('INCR', KEYS[1]); "
        "if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return n",
        1, key, seconds,
    )
    if count > limit:
        raise HTTPException(429, "Too many requests; slow down")


async def app_channel(session, space: Space, channel_id: str, admin: User) -> Channel:
    """A text channel of this space that the admin can read themselves."""
    channel = await session.get(Channel, channel_id)
    if channel is None or channel.space_id != space.id or channel.type != ChannelType.text:
        raise HTTPException(422, "Choose a text channel of this space")
    await readable(session, channel.id, admin.id)
    return channel


# ---------- incoming webhooks ----------

def webhook_out(hook: AppWebhook, channel_name: str | None, token: str | None = None) -> dict:
    out = {
        "id": hook.id, "name": hook.name, "emoji": hook.emoji, "channelId": hook.channel_id,
        "channelName": channel_name, "tokenHint": hook.token_hint,
        "lastUsedAt": hook.last_used_at, "createdAt": hook.created_at,
    }
    if token:
        out["token"] = token
        out["path"] = f"/api/hooks/{token}"
    return out


async def list_webhooks(session, space: Space) -> list[dict]:
    rows = await session.execute(
        select(AppWebhook, Channel.name).join(Channel, Channel.id == AppWebhook.channel_id)
        .where(AppWebhook.space_id == space.id).order_by(AppWebhook.id)
    )
    return [webhook_out(hook, name) for hook, name in rows]


async def create_webhook(session, space: Space, admin: User, data: WebhookIn) -> dict:
    channel = await app_channel(session, space, data.channelId, admin)
    count = await session.scalar(select(func.count()).select_from(AppWebhook).where(AppWebhook.space_id == space.id))
    if count >= MAX_WEBHOOKS:
        raise HTTPException(422, f"A space can have at most {MAX_WEBHOOKS} webhooks")
    token = tokens.new_token(tokens.WEBHOOK_PREFIX)
    identity = tokens.make_bot_user(data.name, data.emoji, "webhook")
    session.add(identity)
    await session.flush()
    hook = AppWebhook(
        space_id=space.id, channel_id=channel.id, bot_user_id=identity.id, name=data.name,
        emoji=data.emoji, token_hash=tokens.hash_token(token), token_hint=tokens.hint(token),
        created_by=admin.id,
    )
    session.add(hook)
    await session.commit()
    return webhook_out(hook, channel.name, token)


async def own_webhook(session, space: Space, hook_id: str) -> AppWebhook:
    hook = await session.get(AppWebhook, hook_id)
    if hook is None or hook.space_id != space.id:
        raise HTTPException(404, "Webhook not found")
    return hook


async def update_webhook(session, space: Space, admin: User, hook_id: str, data: WebhookPatch) -> dict:
    hook = await own_webhook(session, space, hook_id)
    if data.channelId is not None:
        hook.channel_id = (await app_channel(session, space, data.channelId, admin)).id
    identity = await session.get(User, hook.bot_user_id)
    if data.name is not None:
        hook.name = identity.display_name = " ".join(data.name.split())[:80] or hook.name
    if data.emoji is not None:
        hook.emoji = identity.bot_emoji = data.emoji
    await session.commit()
    return webhook_out(hook, (await session.get(Channel, hook.channel_id)).name)


async def regenerate_webhook(session, space: Space, hook_id: str) -> dict:
    hook = await own_webhook(session, space, hook_id)
    token = tokens.new_token(tokens.WEBHOOK_PREFIX)
    hook.token_hash, hook.token_hint = tokens.hash_token(token), tokens.hint(token)
    await session.commit()
    return webhook_out(hook, (await session.get(Channel, hook.channel_id)).name, token)


async def delete_webhook(session, space: Space, hook_id: str) -> None:
    hook = await own_webhook(session, space, hook_id)
    # The identity keeps old messages readable; deleting it would remove them, so only the hook goes.
    await session.delete(hook)
    await session.commit()


async def post_from_webhook(session, token: str, data: HookIn):
    """Returns (message, parent) after posting; the caller broadcasts. Unknown token: 404."""
    hook = await tokens.find_webhook(session, token)
    if hook is None:
        raise HTTPException(404, "Webhook not found")
    await rate_limit(f"rl:hook:{hook.id}", HOOK_PER_MINUTE)
    identity = await session.get(User, hook.bot_user_id)
    hook.last_used_at = datetime.now(UTC)
    message, inserted, parent = await send(
        session, identity,
        SendIn(channelId=hook.channel_id, body=data.text, clientMsgId=str(uuid4())),
        trusted=True, bot_name=data.username,
    )
    return message, inserted, parent, identity


# ---------- bots ----------

async def bot_channels(session, bot: AppBot, viewer: User | None = None) -> list[dict]:
    rows = await session.execute(
        select(Channel.id, Channel.name).join(AppBotChannel, AppBotChannel.channel_id == Channel.id)
        .where(AppBotChannel.bot_id == bot.id).order_by(Channel.name)
    )
    result = []
    for channel_id, name in rows:
        if viewer is not None:
            try:
                await readable(session, channel_id, viewer.id)
            except HTTPException:
                continue  # private channels the admin cannot see stay hidden
        result.append({"id": channel_id, "name": name})
    return result


async def bot_out(session, bot: AppBot, viewer: User, token: str | None = None, secret: bool = False) -> dict:
    out = {
        "id": bot.id, "name": bot.name, "description": bot.description, "emoji": bot.emoji,
        "tokenHint": bot.token_hint, "webhookUrl": bot.webhook_url,
        "channels": await bot_channels(session, bot, viewer), "createdAt": bot.created_at,
    }
    if token:
        out["token"] = token
    if secret:
        out["signingSecret"] = bot.signing_secret
    return out


async def list_bots(session, space: Space, viewer: User) -> list[dict]:
    bots = await session.scalars(select(AppBot).where(AppBot.space_id == space.id).order_by(AppBot.id))
    return [await bot_out(session, bot, viewer) for bot in bots]


def checked_url(url: str | None) -> str | None:
    if not url or not url.strip():
        return None
    try:
        return delivery.check_url(url.strip())
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


async def set_channels(session, bot: AppBot, space: Space, admin: User, channel_ids: list[str]) -> None:
    wanted = set(channel_ids)
    for channel_id in wanted:
        await app_channel(session, space, channel_id, admin)
    current = set(await session.scalars(select(AppBotChannel.channel_id).where(AppBotChannel.bot_id == bot.id)))
    for channel_id in current - wanted:
        try:
            await readable(session, channel_id, admin.id)
        except HTTPException:
            wanted.add(channel_id)  # not the admin's to remove: they cannot even see it
    await session.execute(delete(AppBotChannel).where(AppBotChannel.bot_id == bot.id))
    for channel_id in wanted:
        session.add(AppBotChannel(bot_id=bot.id, channel_id=channel_id, added_by=admin.id))


async def create_bot(session, space: Space, admin: User, data: BotIn) -> dict:
    count = await session.scalar(select(func.count()).select_from(AppBot).where(AppBot.space_id == space.id))
    if count >= MAX_BOTS:
        raise HTTPException(422, f"A space can have at most {MAX_BOTS} bots")
    url = checked_url(data.webhookUrl)
    token = tokens.new_token(tokens.BOT_PREFIX)
    name = " ".join(data.name.split())
    if not name:
        raise HTTPException(422, "Name is required")
    identity = tokens.make_bot_user(name, data.emoji, "bot")
    session.add(identity)
    await session.flush()
    bot = AppBot(
        space_id=space.id, bot_user_id=identity.id, name=name, description=data.description.strip(),
        emoji=data.emoji, token_hash=tokens.hash_token(token), token_hint=tokens.hint(token),
        webhook_url=url, signing_secret=tokens.new_signing_secret(), created_by=admin.id,
    )
    session.add(bot)
    await session.flush()
    await set_channels(session, bot, space, admin, data.channelIds)
    await session.commit()
    return await bot_out(session, bot, admin, token=token, secret=True)


async def own_bot(session, space: Space, bot_id: str) -> AppBot:
    bot = await session.get(AppBot, bot_id)
    if bot is None or bot.space_id != space.id:
        raise HTTPException(404, "Bot not found")
    return bot


async def update_bot(session, space: Space, admin: User, bot_id: str, data: BotPatch) -> dict:
    bot = await own_bot(session, space, bot_id)
    identity = await session.get(User, bot.bot_user_id)
    fields = data.model_fields_set
    if data.name is not None:
        bot.name = " ".join(data.name.split()) or bot.name
        identity.display_name = bot.name[:50]
    if data.description is not None:
        bot.description = data.description.strip()
    if data.emoji is not None:
        bot.emoji = identity.bot_emoji = data.emoji
    if "webhookUrl" in fields:
        bot.webhook_url = checked_url(data.webhookUrl)
        if bot.webhook_url is None and await session.scalar(select(AppCommand.id).where(AppCommand.bot_id == bot.id).limit(1)):
            raise HTTPException(422, "Remove this bot's slash commands before clearing its URL")
    if data.channelIds is not None:
        await set_channels(session, bot, space, admin, data.channelIds)
    await session.commit()
    return await bot_out(session, bot, admin)


async def regenerate_bot(session, space: Space, admin: User, bot_id: str) -> dict:
    bot = await own_bot(session, space, bot_id)
    token = tokens.new_token(tokens.BOT_PREFIX)
    bot.token_hash, bot.token_hint = tokens.hash_token(token), tokens.hint(token)
    await session.commit()
    return await bot_out(session, bot, admin, token=token)


async def rotate_secret(session, space: Space, admin: User, bot_id: str) -> dict:
    bot = await own_bot(session, space, bot_id)
    bot.signing_secret = tokens.new_signing_secret()
    await session.commit()
    return await bot_out(session, bot, admin, secret=True)


async def delete_bot(session, space: Space, bot_id: str) -> None:
    bot = await own_bot(session, space, bot_id)
    await session.delete(bot)
    await session.commit()


async def recent_deliveries(session, space: Space, bot_id: str) -> list[dict]:
    bot = await own_bot(session, space, bot_id)
    rows = await session.scalars(
        select(AppDelivery).where(AppDelivery.bot_id == bot.id).order_by(AppDelivery.id.desc()).limit(20)
    )
    return [
        {"id": d.id, "event": d.event, "status": d.status, "attempts": d.attempts,
         "error": d.last_error, "createdAt": d.created_at, "deliveredAt": d.delivered_at}
        for d in rows
    ]


# ---------- bot REST API ----------

async def authenticate_bot(session, token: str) -> AppBot:
    bot = await tokens.find_bot(session, token)
    if bot is None:
        raise HTTPException(401, "Invalid bot token", headers={"WWW-Authenticate": "Bearer"})
    return bot


async def bot_in_channel(session, bot: AppBot, channel_id: str) -> Channel:
    """The bot may act in a channel only if an admin added it there (and it is still in its space)."""
    channel = await session.get(Channel, channel_id)
    if (
        channel is None or channel.space_id != bot.space_id or channel.type != ChannelType.text
        or await session.get(AppBotChannel, (bot.id, channel.id)) is None
    ):
        raise HTTPException(403, "This bot has not been added to that channel")
    return channel


async def bot_post(session, bot: AppBot, data: BotMessageIn):
    await rate_limit(f"rl:bot:{bot.id}", BOT_PER_MINUTE)
    await bot_in_channel(session, bot, data.channelId)
    identity = await session.get(User, bot.bot_user_id)
    message, inserted, parent = await send(
        session, identity,
        SendIn(channelId=data.channelId, body=data.text, parentId=data.parentId, clientMsgId=str(uuid4())),
        trusted=True,
    )
    return message, inserted, parent, identity


async def bot_channel_list(session, bot: AppBot) -> list[dict]:
    return await bot_channels(session, bot)


async def bot_history(session, bot: AppBot, channel_id: str, before: str | None, limit: int) -> dict:
    await rate_limit(f"rl:botread:{bot.id}", BOT_PER_MINUTE * 2)
    await bot_in_channel(session, bot, channel_id)
    query = _with_authors().where(Message.channel_id == channel_id, Message.deleted_at.is_(None))
    if before:
        query = query.where(Message.id < before)
    rows = list((await session.execute(query.order_by(Message.id.desc()).limit(limit + 1))).all())
    more = len(rows) > limit
    rows = rows[:limit]
    rows.reverse()
    items = await serialize(session, rows, None)
    # Bots get plain content: no per-viewer data, no private links.
    return {"items": [{**item, "channelLinks": [], "poll": None} for item in items], "has_more": more}


# ---------- slash commands ----------

def command_out(command: AppCommand, bot_name: str) -> dict:
    return {
        "id": command.id, "name": command.name, "description": command.description,
        "usage": command.usage or f"/{command.name}", "botId": command.bot_id, "botName": bot_name,
    }


async def list_commands(session, space_id: str) -> list[dict]:
    rows = await session.execute(
        select(AppCommand, AppBot.name).join(AppBot, AppBot.id == AppCommand.bot_id)
        .where(AppCommand.space_id == space_id).order_by(AppCommand.name)
    )
    return [command_out(command, name) for command, name in rows]


async def create_command(session, space: Space, admin: User, data: CommandIn) -> dict:
    bot = await own_bot(session, space, data.botId)
    if not bot.webhook_url:
        raise HTTPException(422, "Give this bot a URL first: commands are sent there")
    count = await session.scalar(select(func.count()).select_from(AppCommand).where(AppCommand.space_id == space.id))
    if count >= MAX_COMMANDS:
        raise HTTPException(422, f"A space can have at most {MAX_COMMANDS} commands")
    row = await session.scalar(
        insert(AppCommand).values(
            space_id=space.id, bot_id=bot.id, name=data.name, description=data.description.strip(),
            usage=data.usage.strip(), created_by=admin.id,
        ).on_conflict_do_nothing(index_elements=["space_id", "name"]).returning(AppCommand)
    )
    if row is None:
        raise HTTPException(409, "That command already exists")
    await session.commit()
    return command_out(row, bot.name)


async def delete_command(session, space: Space, command_id: str) -> None:
    command = await session.get(AppCommand, command_id)
    if command is None or command.space_id != space.id:
        raise HTTPException(404, "Command not found")
    await session.delete(command)
    await session.commit()


async def commands_for_channel(session, channel_id: str, user: User) -> list[dict]:
    channel, member = await readable(session, channel_id, user.id)
    if channel.space_id is None or member is None:
        return []
    return await list_commands(session, channel.space_id)


async def run_command(session, user: User, channel_id: str, data: CommandRun):
    """Sends the command to its bot and returns (text, ephemeral, bot, identity, channel)."""
    channel = await writable(session, channel_id, user.id)
    if channel.space_id is None:
        raise HTTPException(422, "Custom commands work inside spaces")
    name = data.command.strip().lstrip("/").lower()
    command = await session.scalar(
        select(AppCommand).where(AppCommand.space_id == channel.space_id, AppCommand.name == name)
    )
    if command is None:
        raise HTTPException(404, "Unknown command")
    bot = await session.get(AppBot, command.bot_id)
    if bot is None or not bot.webhook_url:
        raise HTTPException(422, "This command has no app behind it")
    if await session.get(AppBotChannel, (bot.id, channel.id)) is None:
        raise HTTPException(422, "This app has not been added to this channel. Ask an admin to add it.")
    await rate_limit(f"rl:cmd:{user.id}", 10, 10)
    space = await session.get(Space, channel.space_id)
    payload = {
        "type": "slash_command",
        "command": name,
        "text": data.text.strip(),
        "user": {"id": user.id, "username": user.username, "displayName": user.display_name},
        "channel": {"id": channel.id, "name": channel.name},
        "space": {"id": space.id, "slug": space.slug},
        "timestamp": datetime.now(UTC).isoformat(),
    }
    try:
        status, body = await delivery.post_signed(bot.webhook_url, bot.signing_secret, "command", payload)
    except delivery.DeliveryError as error:
        raise HTTPException(502, f"{bot.name} could not be reached ({error})") from None
    if not 200 <= status < 300:
        raise HTTPException(502, f"{bot.name} answered with an error ({status})")
    try:
        answer = delivery_json(body)
    except ValueError:
        raise HTTPException(502, f"{bot.name} sent an answer Hive could not read") from None
    return answer["text"], answer["ephemeral"], bot


def delivery_json(body: bytes) -> dict:
    import json

    value = json.loads(body.decode("utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("text"), str) or not value["text"].strip():
        raise ValueError("no text")
    text = value["text"].strip()
    if len(text) > 4000:
        text = text[:3997] + "..."
    return {"text": text, "ephemeral": value.get("ephemeral") is True}


async def post_command_answer(session, bot: AppBot, channel_id: str, text: str, parent_id: str | None):
    identity = await session.get(User, bot.bot_user_id)
    message, inserted, parent = await send(
        session, identity,
        SendIn(channelId=channel_id, body=text, parentId=parent_id, clientMsgId=str(uuid4())),
        trusted=True,
    )
    return message, inserted, parent, identity
