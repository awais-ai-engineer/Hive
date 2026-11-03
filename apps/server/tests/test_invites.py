import asyncio
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update

from app.db.models import Invite, Space, SpaceMember, User
from app.db.session import SessionLocal
from tests.helpers import create_account


async def account(client, name):
    return await create_account(client, name, f"{name}@example.test")


async def create_workspace(client, owner_headers):
    return await client.post(
        "/api/spaces",
        headers=owner_headers,
        json={"type": "workspace", "name": "Invite Space", "slug": "invite-space"},
    )


async def create_invite(client, owner_headers, body=None):
    return await client.post(
        "/api/spaces/invite-space/invites", headers=owner_headers, json=body or {}
    )


async def test_invite_preview_accept_and_use_limit(client):
    _, owner = await account(client, "owner")
    await create_workspace(client, owner)
    invite = await create_invite(client, owner, {"max_uses": 1})
    assert invite.status_code == 201
    code = invite.json()["code"]
    assert len(code) <= 16
    preview = await client.get(f"/api/invites/{code}")
    assert preview.status_code == 200
    assert preview.json() == {
        "space": {
            "name": "Invite Space",
            "slug": "invite-space",
            "type": "workspace",
            "description": None,
            "member_count": 1,
        },
        "valid": True,
    }
    _, first = await account(client, "first")
    accepted = await client.post(f"/api/invites/{code}/accept", headers=first)
    assert accepted.status_code == 200 and accepted.json()["my_role"] == "member"
    _, second = await account(client, "second")
    response = await client.post(f"/api/invites/{code}/accept", headers=second)
    assert response.status_code == 410 and response.json()["detail"] == "Invite expired or used up"
    assert (await client.get(f"/api/invites/{code}")).json()["valid"] is False
    async with SessionLocal() as session:
        stored = await session.scalar(select(Invite).where(Invite.code == code))
        assert stored.uses == 1


async def test_invite_expiry_revocation_unknown_and_existing_member(client):
    _, owner = await account(client, "owner")
    await create_workspace(client, owner)
    _, existing = await account(client, "existing")
    first_invite = await create_invite(client, owner)
    assert (
        await client.post(f"/api/invites/{first_invite.json()['code']}/accept", headers=existing)
    ).status_code == 200
    invite = await create_invite(client, owner, {"max_uses": 2})
    code = invite.json()["code"]
    before = invite.json()["uses"]
    accepted = await client.post(f"/api/invites/{code}/accept", headers=existing)
    assert accepted.status_code == 200
    assert (await client.get("/api/spaces/invite-space/invites", headers=owner)).json()[0][
        "uses"
    ] == before
    assert (await client.get("/api/invites/unknown")).status_code == 404
    expiring = await create_invite(client, owner)
    expiring_code = expiring.json()["code"]
    async with SessionLocal() as session:
        await session.execute(
            update(Invite)
            .where(Invite.code == expiring_code)
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await session.commit()
    _, late = await account(client, "late")
    assert (
        await client.post(f"/api/invites/{expiring_code}/accept", headers=late)
    ).status_code == 410
    revoked = await create_invite(client, owner)
    assert (
        await client.delete(
            f"/api/spaces/invite-space/invites/{revoked.json()['id']}", headers=owner
        )
    ).status_code == 204
    assert (
        await client.post(f"/api/invites/{revoked.json()['code']}/accept", headers=late)
    ).status_code == 410


async def test_invite_use_limit_is_atomic(client):
    _, owner = await account(client, "owner")
    await create_workspace(client, owner)
    invitation = await create_invite(client, owner, {"max_uses": 1})
    code = invitation.json()["code"]
    users = [await account(client, f"person{index}") for index in range(5)]
    responses = await asyncio.gather(
        *(client.post(f"/api/invites/{code}/accept", headers=headers) for _, headers in users)
    )
    assert [response.status_code for response in responses].count(200) == 1
    assert [response.status_code for response in responses].count(410) == 4
    async with SessionLocal() as session:
        stored = await session.scalar(select(Invite).where(Invite.code == code))
        assert stored.uses == 1
        joined = await session.scalar(select(Space).where(Space.slug == "invite-space"))
        assert await session.scalar(select(Invite.uses).where(Invite.space_id == joined.id)) == 1


async def test_invite_admin_permissions_validation_and_ban(client):
    _, owner = await account(client, "owner")
    _, member = await account(client, "member")
    await create_workspace(client, owner)
    invite = await create_invite(client, owner)
    await client.post(f"/api/invites/{invite.json()['code']}/accept", headers=member)
    assert (await create_invite(client, member)).status_code == 403
    for data in [
        {"max_uses": 0},
        {"max_uses": 1001},
        {"expires_in_hours": 0},
        {"expires_in_hours": 721},
    ]:
        assert (await create_invite(client, owner, data)).status_code == 422
    async with SessionLocal() as session:
        space = await session.scalar(select(Space).where(Space.slug == "invite-space"))
        user = await session.scalar(select(User).where(User.username == "member"))
        await session.execute(
            update(SpaceMember)
            .where(SpaceMember.space_id == space.id, SpaceMember.user_id == user.id)
            .values(banned_until=datetime.now(UTC) + timedelta(days=1))
        )
        await session.commit()
    assert (
        await client.post(f"/api/invites/{invite.json()['code']}/accept", headers=member)
    ).status_code == 403
