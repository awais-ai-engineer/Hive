from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import ask as asking
from app.ai import factory, service, translate
from app.ai.languages import LANGUAGES
from app.ai.schemas import (
    AskIn,
    HuddleNotesIn,
    PriorityIn,
    RewriteIn,
    SummarizeIn,
    TranslateBatchIn,
    TranslateIn,
)
from app.auth.deps import get_current_user
from app.db.models import AiUsage, User
from app.db.session import get_session

Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


async def ai_enabled(_: CurrentUser) -> None:
    service.require_enabled()


router = APIRouter(prefix="/ai", tags=["ai"])
gated = APIRouter(dependencies=[Depends(ai_enabled)])
me_router = APIRouter(tags=["ai"])


@router.get("/status")
async def status(_: CurrentUser):
    enabled = factory.get_provider() is not None
    return {"enabled": enabled,
            "languages": [{"code": code, "name": name} for code, name in LANGUAGES.items()] if enabled else []}


@gated.post("/translate")
async def post_translate(data: TranslateIn, session: Session, user: CurrentUser):
    translate.language_name(data.language)
    (result,) = await translate.translate_many(
        session, user, [(data.targetType, data.targetId)], data.language, strict=True)
    if result["status"] == "failed":
        raise HTTPException(502, detail={"code": "ai_unreadable", "message": "The translation did not come back. Please try again."})
    return result


@gated.post("/translate-batch")
async def post_translate_batch(data: TranslateBatchIn, session: Session, user: CurrentUser):
    translate.language_name(data.language)
    items = await translate.translate_many(
        session, user, [(i.targetType, i.targetId) for i in data.items], data.language, strict=False)
    return {"items": items}


@gated.post("/rewrite")
async def post_rewrite(data: RewriteIn, session: Session, user: CurrentUser):
    return await service.rewrite(session, user, data.text, data.mode)


@gated.post("/summarize")
async def post_summarize(data: SummarizeIn, session: Session, user: CurrentUser):
    return await service.summarize(session, user, data)


@gated.post("/huddle-notes")
async def post_huddle_notes(data: HuddleNotesIn, session: Session, user: CurrentUser):
    return await service.huddle_notes(session, user, data)


@gated.post("/priority")
async def post_priority(data: PriorityIn, session: Session, user: CurrentUser):
    return await service.priority(session, user, data.refresh)


@gated.post("/ask")
async def post_ask(data: AskIn, session: Session, user: CurrentUser):
    return await asking.ask(session, user, data.question, data.spaceId)


router.include_router(gated)


@me_router.get("/me/ai-usage")
async def my_usage(session: Session, user: CurrentUser):
    since = datetime.now(UTC) - timedelta(days=30)
    rows = (await session.execute(
        select(AiUsage.feature, func.count(), func.coalesce(func.sum(AiUsage.input_tokens), 0),
               func.coalesce(func.sum(AiUsage.output_tokens), 0))
        .where(AiUsage.user_id == user.id, AiUsage.created_at >= since).group_by(AiUsage.feature))).all()
    return {"days": 30, "calls": sum(r[1] for r in rows), "inputTokens": int(sum(r[2] for r in rows)),
            "outputTokens": int(sum(r[3] for r in rows)),
            "byFeature": {r[0]: {"calls": r[1], "inputTokens": int(r[2]), "outputTokens": int(r[3])} for r in rows}}
