"""Optional audio eligibility; communication permissions remain a separate policy."""
from datetime import UTC, datetime

from sqlalchemy import select

from app.availability.service import active
from app.db.models import ConversationPref, SpaceMember, User
from app.push.service import in_quiet_hours


async def optional_audio_allowed(session, user_id, channel_id=None, space_id=None, mention=False):
    user = await session.get(User, user_id)
    if user is None or in_quiet_hours(user.quiet_start, user.quiet_end, user.quiet_tz):
        return False
    if user.out_of_office_until and user.out_of_office_until >= datetime.now(UTC).date():
        return False
    if any(item.suppress_notifications for item in await active(session, user_id)):
        return False
    if space_id and await session.scalar(select(SpaceMember.muted).where(
        SpaceMember.space_id == space_id, SpaceMember.user_id == user_id,
    )):
        return False
    if channel_id:
        pref = await session.get(ConversationPref, (user_id, channel_id))
        if pref and (pref.level == 'nothing' or not mention):
            return False
    return True
