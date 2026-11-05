from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.comments.service import get_post_and_check_visibility
from app.db.models import Comment, Message, Report, ReportTarget, User
from app.db.session import redis
from app.messages.service import readable
from app.reports.schemas import ReportIn

REPORTS_PER_HOUR = 10


async def _check_rate(user_id: str) -> None:
    count = await redis.eval(
        "local n = redis.call('INCR', KEYS[1]); "
        "if n == 1 then redis.call('EXPIRE', KEYS[1], 3600) end; return n",
        1, f"rl:report:{user_id}",
    )
    if count > REPORTS_PER_HOUR:
        raise HTTPException(429, "Too many reports; try again later")


async def _require_visible(session: AsyncSession, reporter: User, data: ReportIn) -> None:
    """The target must exist and be something the reporter can see; otherwise 404, so reports
    can't be used to probe for private messages, workspace posts or comments."""
    missing = HTTPException(404, "Nothing to report")
    kind, target_id = data.target_type, data.target_id
    if kind == ReportTarget.user:
        if target_id == reporter.id:
            raise HTTPException(422, "You can't report yourself")
        if await session.get(User, target_id) is None:
            raise missing
    elif kind == ReportTarget.message:
        message = await session.get(Message, target_id)
        if message is None:
            raise missing
        try:
            await readable(session, message.channel_id, reporter.id)
        except HTTPException:
            raise missing from None
    else:
        post_id = target_id
        if kind == ReportTarget.comment:
            comment = await session.get(Comment, target_id)
            if comment is None:
                raise missing
            post_id = comment.post_id
        try:
            await get_post_and_check_visibility(session, post_id, reporter.id)
        except HTTPException:
            raise missing from None


async def create_report(session: AsyncSession, reporter: User, data: ReportIn) -> Report:
    await _check_rate(reporter.id)
    await _require_visible(session, reporter, data)
    report = Report(
        reporter_id=reporter.id, target_type=data.target_type, target_id=data.target_id,
        reason=data.reason,
    )
    session.add(report)
    await session.commit()
    return report
