from fastapi import HTTPException

from app.db.models import MemberRole

ROLE_RANK = {
    MemberRole.owner: 5,
    MemberRole.admin: 4,
    MemberRole.moderator: 3,
    MemberRole.member: 2,
    MemberRole.guest: 1,
}


def require_role(role: MemberRole | None, minimum: MemberRole) -> None:
    if role is None or ROLE_RANK[role] < ROLE_RANK[minimum]:
        raise HTTPException(403, "Insufficient role")


def require_below(actor: MemberRole, target: MemberRole) -> None:
    if ROLE_RANK[target] >= ROLE_RANK[actor]:
        raise HTTPException(403, "Insufficient role")
