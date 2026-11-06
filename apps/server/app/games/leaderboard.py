"""Leaderboards and badges, both computed from the append-only game_scores rows."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import GameScore, User

TOP_N = 50
BADGE_PLACES = 3


def week_start(moment: datetime) -> datetime:
    """Monday 00:00 UTC of the ISO week containing `moment`."""
    day = moment.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return day - timedelta(days=day.weekday())


def period_bounds(period: str, now: datetime | None = None) -> tuple[datetime | None, datetime | None]:
    now = now or datetime.now(UTC)
    if period == "daily":
        return now.replace(hour=0, minute=0, second=0, microsecond=0), None
    if period == "weekly":
        return week_start(now), None
    return None, None


def _totals(space_id: str, start: datetime | None, end: datetime | None, game: str | None):
    query = select(GameScore.user_id, func.sum(GameScore.points).label("points")).where(
        GameScore.space_id == space_id)
    if start is not None:
        query = query.where(GameScore.created_at >= start)
    if end is not None:
        query = query.where(GameScore.created_at < end)
    if game is not None:
        query = query.where(GameScore.game == game)
    return query.group_by(GameScore.user_id).having(func.sum(GameScore.points) > 0).subquery()


async def top_players(session: AsyncSession, space_id: str, now: datetime | None = None) -> set[str]:
    """Top three of the last completed ISO week (the "Top player" badge)."""
    this_week = week_start(now or datetime.now(UTC))
    totals = _totals(space_id, this_week - timedelta(days=7), this_week, None)
    rows = await session.execute(
        select(totals.c.user_id).order_by(totals.c.points.desc(), totals.c.user_id).limit(BADGE_PLACES))
    return set(rows.scalars())


def _person(user: User, points: int, rank: int, badge: set[str]) -> dict:
    return {"rank": rank, "points": int(points), "topPlayer": user.id in badge,
            "user": {"id": user.id, "username": user.username, "displayName": user.display_name,
                     "avatarUrl": user.avatar_url}}


async def board(
    session: AsyncSession, space_id: str, viewer_id: str, period: str, game: str | None,
    now: datetime | None = None,
) -> dict:
    start, end = period_bounds(period, now)
    totals = _totals(space_id, start, end, game)
    ranked = select(
        totals.c.user_id, totals.c.points,
        func.rank().over(order_by=totals.c.points.desc()).label("rank"),
    ).subquery()
    badge = await top_players(session, space_id, now)
    rows = (await session.execute(
        select(User, ranked.c.points, ranked.c.rank).join(User, User.id == ranked.c.user_id)
        .order_by(ranked.c.rank, User.username).limit(TOP_N))).all()
    mine = (await session.execute(
        select(User, ranked.c.points, ranked.c.rank).join(User, User.id == ranked.c.user_id)
        .where(ranked.c.user_id == viewer_id))).first()
    return {
        "period": period, "game": game,
        "entries": [_person(user, points, rank, badge) for user, points, rank in rows],
        "me": _person(*mine[:2], mine[2], badge) if mine else None,
    }
