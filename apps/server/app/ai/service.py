"""Calling the model (with limits and usage logging) and the chat-summary features."""

import hashlib
import json
import re

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import context, factory
from app.ai.context import Snippet
from app.ai.prompt import neutralize, parse_sections, system_prompt, wrap
from app.ai.provider import AIError, AIMessage, AIResult
from app.ai.schemas import HuddleNotesIn, SummarizeIn
from app.core.config import settings
from app.core.limits import hit
from app.db.models import AiUsage, Channel, Message, User
from app.db.session import redis
from app.messages.service import readable

DISABLED = {"code": "ai_disabled", "message": "AI features are not set up on this server."}
PRIORITY_TTL = 600

SUMMARY_TASK = (
    "You summarise chat conversations for a busy reader. Every message is a numbered line such as "
    "`[3] name in #channel: text`. Write short bullet points ('- ...'), each under 25 words, and "
    "cite the messages a point comes from by number in square brackets, for example [2][5]. "
    "Use these '## ' sections, only when they have content: 'Key points', 'Decisions', "
    "'Open questions'. Never invent anything that is not in the messages."
)
CATCH_UP_TASK = (
    "You help someone catch up on chat they missed. Every message is a numbered line such as "
    "`[3] name in #channel: text`. Write 3 to 8 short bullet points ('- ...'), each under 25 "
    "words, most important first, and cite the messages each point comes from by number in "
    "square brackets, for example [2][5]. Mention anything that needs the reader's attention. "
    "Never invent anything that is not in the messages."
)
HUDDLE_TASK = (
    "You write notes about the chat that happened while a voice huddle was running. Every message "
    "is a numbered line such as `[3] name: text`. Write short bullet points ('- ...') under these "
    "'## ' sections, only when they have content: 'Key points', 'Decisions', 'Action items'. "
    "Action items are things somebody agreed or was asked to do; write each as a short task and "
    "cite the message it comes from by number in square brackets, for example [2]. "
    "Never invent anything that is not in the messages."
)
PRIORITY_TASK = (
    "You help a person decide which unread conversations to open first. Each conversation is a "
    "block starting with `### Conversation N`. Rate every conversation for the reader as one of: "
    "urgent (needs a reply or action soon, a direct question, a deadline, or mentions the reader), "
    "for you (relevant to the reader but not time-critical), later (chatter, announcements, "
    "nothing needed). Answer with exactly one line per conversation in the form "
    "`N | urgent or for you or later | reason of at most 12 words`."
)


def require_enabled() -> None:
    if factory.get_provider() is None:
        raise HTTPException(503, detail=DISABLED)


async def call_model(
    session: AsyncSession, user: User, feature: str, task: str, prompt: str,
    *, space_id: str | None = None, max_tokens: int | None = None,
) -> AIResult:
    """Rate-limits, calls the provider and records usage. `prompt` goes in the user turn."""
    provider = factory.get_provider()
    if provider is None:
        raise HTTPException(503, detail=DISABLED)
    await hit(f"rl:ai:{user.id}", settings.ai_rate_limit_per_hour, 3600,
              "You have used a lot of AI features this hour. Please try again a little later.")
    try:
        result = await provider.complete(
            system=system_prompt(task), messages=[AIMessage("user", prompt)],
            max_tokens=max_tokens or settings.ai_max_output_tokens)
    except AIError as error:
        raise HTTPException(502, detail={"code": error.code, "message": error.message}) from None
    session.add(AiUsage(user_id=user.id, feature=feature, model=result.model,
                        input_tokens=result.input_tokens, output_tokens=result.output_tokens,
                        space_id=space_id))
    await session.commit()
    return result


async def space_of(session: AsyncSession, channel_id: str | None) -> str | None:
    channel = await session.get(Channel, channel_id) if channel_id else None
    return channel.space_id if channel else None


def sources(refs: list[int], by_number: dict[int, Snippet]) -> list[dict]:
    return [{"n": n, "messageId": s.message_id, "channelId": s.channel_id, "url": s.url,
             "author": s.author, "place": s.place}
            for n in refs if (s := by_number.get(n)) is not None]


def render(text: str, snippets: list[Snippet]) -> dict:
    by_number = {s.n: s for s in snippets}
    parsed = parse_sections(text, set(by_number))
    return {name: [{"text": item["text"], "sources": sources(item["refs"], by_number)} for item in items]
            for name, items in parsed.items()}


def lines(snippets: list[Snippet]) -> str:
    return wrap("\n".join(s.line() for s in snippets))


EMPTY = {"points": [], "decisions": [], "questions": [], "actions": []}


async def summarize(session: AsyncSession, user: User, data: SummarizeIn) -> dict:
    channel_id = data.channelId
    scope = "channel"
    if data.allUnreads:
        snippets, _ = await context.all_unreads(session, user)
        scope, task = "unreads", CATCH_UP_TASK
    elif channel_id and data.parentId:
        snippets = await context.thread_snippets(session, user, channel_id, data.parentId)
        scope, task = "thread", SUMMARY_TASK
    elif channel_id and data.sinceUnread:
        snippets, scope = await context.channel_catch_up(session, user, channel_id)
        task = CATCH_UP_TASK
    elif channel_id:
        snippets = await context.channel_recent(session, user, channel_id)
        task = SUMMARY_TASK
    else:
        raise HTTPException(422, "Choose a conversation to summarise.")
    base = {"scope": scope, "messageCount": len(snippets)}
    if not snippets:
        return {**base, **EMPTY, "empty": True}
    result = await call_model(session, user, "summary", task, lines(snippets),
                              space_id=await space_of(session, channel_id))
    return {**base, **render(result.text, snippets), "empty": False}


async def huddle_notes(session: AsyncSession, user: User, data: HuddleNotesIn) -> dict:
    message = await session.get(Message, data.messageId)
    if message is None:
        raise HTTPException(404, "Message not found")
    await readable(session, message.channel_id, user.id)
    if message.kind != "huddle":
        raise HTTPException(422, "This is not a huddle summary.")
    if message.huddle_started_at is None:
        raise HTTPException(422, "This huddle was recorded before chat summaries were available.")
    snippets = await context.channel_window(
        session, user, message.channel_id, message.huddle_started_at, message.created_at)
    base = {"scope": "huddle", "messageCount": len(snippets), "channelId": message.channel_id}
    if not snippets:
        return {**base, **EMPTY, "empty": True}
    result = await call_model(session, user, "huddle", HUDDLE_TASK, lines(snippets),
                              space_id=await space_of(session, message.channel_id))
    return {**base, **render(result.text, snippets), "empty": False}


async def rewrite(session: AsyncSession, user: User, text: str, mode: str) -> dict:
    instructions = {
        "shorter": "Make the text shorter while keeping its meaning and tone.",
        "professional": "Rewrite the text in a clear, professional tone.",
        "friendlier": "Rewrite the text in a warmer, friendlier tone.",
        "fix_grammar": "Fix spelling and grammar only. Keep the wording otherwise.",
    }[mode]
    task = (f"You rewrite a short message for the person who wrote it. {instructions} "
            "Keep names, @mentions, links and code unchanged. Reply with the rewritten text only.")
    result = await call_model(session, user, "rewrite", task, wrap(text), max_tokens=1500)
    return {"text": result.text}


# Smart priority -------------------------------------------------------------------------------

LEVELS = {"urgent": "urgent", "for you": "for_you", "for_you": "for_you", "later": "later"}


async def priority(session: AsyncSession, user: User, refresh: bool = False) -> dict:
    snippets, places = await context.all_unreads(session, user)
    if not places:
        return {"items": [], "cached": False}
    fingerprint = hashlib.sha256(
        "|".join(f"{p['channelId']}:{p['lastId']}:{p['unread']}" for p in sorted(places, key=lambda p: p["channelId"])).encode()
    ).hexdigest()[:24]
    key = f"ai:prio:{user.id}:{fingerprint}"
    current = {p["channelId"] for p in places}
    cached = None if refresh else await redis.get(key)
    if cached:
        items = [item for item in json.loads(cached) if item["channelId"] in current]
        return {"items": items, "cached": True}
    blocks = []
    for number, place in enumerate(places, start=1):
        mine = [s for s in snippets if s.channel_id == place["channelId"]]
        blocks.append(f"### Conversation {number}: {neutralize(place['label'])} ({place['unread']} new)\n"
                      + "\n".join(f"{s.author}: {s.text}" for s in mine))
    prompt = f"The reader is {user.username}.\n\n" + wrap("\n\n".join(blocks))
    result = await call_model(session, user, "priority", PRIORITY_TASK, prompt, max_tokens=1000)
    rated: dict[int, tuple[str, str]] = {}
    for line in result.text.splitlines():
        match = re.match(r"^\W*(\d+)\W*\|\s*([A-Za-z_ ]+?)\s*\|\s*(.+)$", line.strip())
        if match and match.group(2).lower() in LEVELS and 1 <= int(match.group(1)) <= len(places):
            rated[int(match.group(1))] = (LEVELS[match.group(2).lower()], match.group(3).strip()[:140])
    items = []
    for number, place in enumerate(places, start=1):
        level, reason = rated.get(number, ("later", ""))
        items.append({"channelId": place["channelId"], "level": level, "reason": reason})
    await redis.set(key, json.dumps(items), ex=PRIORITY_TTL)
    return {"items": items, "cached": False}
