"""Predictions: admins ask a question, members vote, admins settle it and winners get points."""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    GameScore,
    Prediction,
    PredictionOption,
    PredictionVote,
    Space,
    User,
)
from app.games.schemas import PredictionIn


async def load_prediction(session: AsyncSession, space: Space, prediction_id: str) -> Prediction:
    prediction = await session.get(Prediction, prediction_id)
    if prediction is None or prediction.space_id != space.id:
        raise HTTPException(404, "Prediction not found")
    return prediction


async def create(session: AsyncSession, space: Space, user: User, data: PredictionIn) -> Prediction:
    if data.closesAt.tzinfo is None:
        raise HTTPException(422, "Include a time zone in the closing time.")
    if data.closesAt <= datetime.now(UTC):
        raise HTTPException(422, "Choose a closing time in the future.")
    prediction = Prediction(space_id=space.id, created_by=user.id, question=data.question,
                            closes_at=data.closesAt, points=data.points)
    session.add(prediction)
    await session.flush()
    session.add_all([PredictionOption(prediction_id=prediction.id, position=i, label=label)
                     for i, label in enumerate(data.options)])
    await session.commit()
    return prediction


async def listing(session: AsyncSession, space: Space, user: User) -> list[dict]:
    predictions = list(await session.scalars(
        select(Prediction).where(Prediction.space_id == space.id).order_by(Prediction.id.desc()).limit(50)))
    ids = [p.id for p in predictions]
    options = list(await session.scalars(
        select(PredictionOption).where(PredictionOption.prediction_id.in_(ids))
        .order_by(PredictionOption.position))) if ids else []
    counts = dict((await session.execute(
        select(PredictionVote.option_id, func.count()).where(PredictionVote.prediction_id.in_(ids))
        .group_by(PredictionVote.option_id))).all()) if ids else {}
    mine = dict((await session.execute(
        select(PredictionVote.prediction_id, PredictionVote.option_id)
        .where(PredictionVote.prediction_id.in_(ids), PredictionVote.user_id == user.id))).all()) if ids else {}
    now = datetime.now(UTC)
    return [{
        "id": p.id, "question": p.question, "closesAt": p.closes_at, "points": p.points,
        "status": p.status, "resolvedOptionId": p.resolved_option_id, "myOptionId": mine.get(p.id),
        "votingOpen": p.status == "open" and p.closes_at > now,
        "options": [{"id": o.id, "label": o.label, "votes": counts.get(o.id, 0)}
                    for o in options if o.prediction_id == p.id],
    } for p in predictions]


async def vote(session: AsyncSession, prediction: Prediction, user: User, option_id: str) -> None:
    if prediction.status != "open" or prediction.closes_at <= datetime.now(UTC):
        raise HTTPException(409, "Voting on this prediction has closed.")
    option = await session.get(PredictionOption, option_id)
    if option is None or option.prediction_id != prediction.id:
        raise HTTPException(422, "Choose one of the listed options.")
    statement = insert(PredictionVote).values(
        prediction_id=prediction.id, user_id=user.id, option_id=option.id)
    await session.execute(statement.on_conflict_do_update(
        index_elements=["prediction_id", "user_id"], set_={"option_id": option.id}))
    await session.commit()


async def resolve(session: AsyncSession, prediction: Prediction, option_id: str) -> int:
    """Settles the prediction once; returns how many people won points."""
    option = await session.get(PredictionOption, option_id)
    if option is None or option.prediction_id != prediction.id:
        raise HTTPException(422, "Choose one of the listed options.")
    claimed = await session.scalar(
        update(Prediction).where(Prediction.id == prediction.id, Prediction.status == "open")
        .values(status="resolved", resolved_option_id=option.id).returning(Prediction.id))
    if claimed is None:
        raise HTTPException(409, "This prediction is already settled.")
    winners = list(await session.scalars(select(PredictionVote.user_id).where(
        PredictionVote.prediction_id == prediction.id, PredictionVote.option_id == option.id)))
    session.add_all([GameScore(space_id=prediction.space_id, user_id=uid, game="prediction",
                               points=prediction.points, ref_id=prediction.id) for uid in winners])
    await session.commit()
    return len(winners)


async def cancel(session: AsyncSession, prediction: Prediction) -> None:
    claimed = await session.scalar(
        update(Prediction).where(Prediction.id == prediction.id, Prediction.status == "open")
        .values(status="canceled").returning(Prediction.id))
    if claimed is None:
        raise HTTPException(409, "This prediction is already settled.")
    await session.commit()
