"""Translation of messages, posts and comments, cached per item, language and text."""

import hashlib
import re

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.languages import LANGUAGES
from app.ai.prompt import wrap
from app.ai.service import call_model, space_of
from app.comments.service import get_post_and_check_visibility
from app.core.config import settings
from app.db.models import AiTranslation, Comment, Message, User
from app.messages.service import readable

TASK = (
    "You are a translator. Translate each numbered item into {language}. Keep @mentions, usernames, "
    "URLs, emoji and code (inline or in blocks) exactly as written. Do not add notes. If an item "
    "is already written in {language}, answer for that item with just `=`. Answer in the form "
    "`[[N]] translation` starting each item on a new line, in the same order."
)


def language_name(code: str) -> str:
    name = LANGUAGES.get(code)
    if name is None:
        raise HTTPException(422, "That language is not supported.")
    return name


async def source_text(session: AsyncSession, user: User, target_type: str, target_id: str) -> tuple[str, str | None]:
    """The text of something the user may read, and the space it belongs to. 404 otherwise."""
    if target_type == "message":
        message = await session.get(Message, target_id)
        if message is None:
            raise HTTPException(404, "Message not found")
        await readable(session, message.channel_id, user.id)
        if message.deleted_at is not None:
            raise HTTPException(404, "Message not found")
        if message.kind not in ("text", "poll") or not message.body.strip():
            raise HTTPException(422, "There is nothing to translate here.")
        return message.body, await space_of(session, message.channel_id)
    if target_type == "post":
        post, space, _ = await get_post_and_check_visibility(session, target_id, user.id)
        if post.deleted_at is not None:
            raise HTTPException(404, "Post not found")
        return (post.title + ("\n\n" + post.body if post.body else "")), space.id
    comment = await session.get(Comment, target_id)
    if comment is None:
        raise HTTPException(404, "Comment not found")
    _, space, _ = await get_post_and_check_visibility(session, comment.post_id, user.id)
    if comment.deleted_at is not None or not comment.body:
        raise HTTPException(404, "Comment not found")
    return comment.body, space.id


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def item_block(number: int, text: str) -> str:
    return f"[[{number}]] " + text[: settings.ai_max_input_chars].replace("[[", "[ [")


def parse(text: str) -> dict[int, str]:
    parts = re.split(r"(?m)^\[\[(\d+)\]\]", text)
    return {int(parts[i]): parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}


async def translate_many(
    session: AsyncSession, user: User, targets: list[tuple[str, str]], code: str, *, strict: bool,
) -> list[dict]:
    """One result per target. With strict=True an unreadable target raises; otherwise it is
    reported as unavailable. Cache hits cost no model call and do not count against the limit."""
    language = language_name(code)
    results: list[dict] = []
    pending: list[tuple[int, str, str | None]] = []
    for target_type, target_id in targets:
        entry = {"targetType": target_type, "targetId": target_id, "language": code,
                 "translation": None, "alreadyInLanguage": False, "cached": False, "status": "ok"}
        results.append(entry)
        try:
            text, space_id = await source_text(session, user, target_type, target_id)
        except HTTPException:
            if strict:
                raise
            entry["status"] = "unavailable"
            continue
        entry["_hash"], entry["_text"], entry["_space"] = digest(text), text, space_id
        hit_row = await session.scalar(select(AiTranslation).where(
            AiTranslation.target_type == target_type, AiTranslation.target_id == target_id,
            AiTranslation.language == code, AiTranslation.text_hash == entry["_hash"]))
        if hit_row is not None:
            entry["cached"] = True
            entry["alreadyInLanguage"] = hit_row.translation == ""
            entry["translation"] = hit_row.translation or None
        else:
            pending.append((len(results) - 1, text, space_id))
    if pending:
        prompt = wrap("\n".join(item_block(n, text) for n, (_, text, _) in enumerate(pending, start=1)))
        result = await call_model(session, user, "translate", TASK.format(language=language), prompt,
                                  space_id=pending[0][2], max_tokens=settings.ai_max_output_tokens)
        answers = parse(result.text)
        for n, (index, _, _) in enumerate(pending, start=1):
            entry = results[index]
            answer = answers.get(n)
            if answer is None:
                entry["status"] = "failed"
                continue
            same = answer.strip() == "="
            entry["alreadyInLanguage"], entry["translation"] = same, None if same else answer
            await session.execute(insert(AiTranslation).values(
                target_type=entry["targetType"], target_id=entry["targetId"], language=code,
                text_hash=entry["_hash"], translation="" if same else answer).on_conflict_do_nothing())
        await session.commit()
    for entry in results:
        for private in ("_hash", "_text", "_space"):
            entry.pop(private, None)
    return results
