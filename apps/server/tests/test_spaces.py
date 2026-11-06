from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from app.db.models import Channel, MemberRole, Space, SpaceMember, User
from app.db.session import SessionLocal
from tests.helpers import create_account


async def account(client, username="owner", email=None):
    email = email or f"{username}@example.test"
    return await create_account(client, username, email)


async def community(client, auth, slug="test-space", name="Test Community"):
    return await client.post(
        "/api/spaces",
        headers=auth,
        json={"type": "community", "name": name, "slug": slug},
    )


async def workspace(client, auth, slug="test-workspace", domain=None):
    return await client.post(
        "/api/spaces",
        headers=auth,
        json={
            "type": "workspace",
            "name": "Test Workspace",
            "slug": slug,
            "allowed_email_domain": domain,
        },
    )


async def test_create_space_owner_general_and_validation(client):
    session, auth = await account(client)
    response = await community(client, auth)
    assert response.status_code == 201
    body = response.json()
    assert body["my_role"] == "owner" and body["member_count"] == 1
    channels = await client.get("/api/spaces/test-space/channels")
    assert [(item["name"], item["type"], item["position"]) for item in channels.json()] == [
        ("general", "text", 0)
    ]
    for slug in ["a", "two--words", "Upper", "new", "settings", "api", "invite", "admin"]:
        response = await community(client, auth, slug=slug)
        assert response.status_code == 422, slug
    assert (await community(client, auth, "test-space")).status_code == 409
    assert (
        await client.post(
            "/api/spaces",
            headers=auth,
            json={
                "type": "community",
                "name": "Test",
                "slug": "domain-space",
                "allowed_email_domain": "acme.test",
            },
        )
    ).status_code == 422
    assert (
        await client.post(
            "/api/spaces",
            headers=auth,
            json={
                "type": "workspace",
                "name": "Bad Domain",
                "slug": "bad-domain",
                "allowed_email_domain": "not a domain",
            },
        )
    ).status_code == 422
    assert body["id"] and session["user"]["id"]


async def test_public_private_visibility_and_discovery(client):
    _, owner_auth = await account(client)
    await community(client, owner_auth, "public-space")
    await workspace(client, owner_auth, "private-space")
    public = await client.get("/api/spaces/public-space")
    assert public.status_code == 200
    assert (await client.get("/api/spaces/public-space/channels")).status_code == 200
    assert (await client.get("/api/spaces/private-space")).status_code == 404
    assert (await client.get("/api/spaces/private-space/channels")).status_code == 404
    assert (await client.get("/api/spaces/private-space/members")).status_code == 404
    items = (await client.get("/api/spaces")).json()["items"]
    assert [item["slug"] for item in items] == ["public-space"]
    assert (await client.get("/api/spaces?q=public")).json()["items"][0]["slug"] == "public-space"


async def test_discovery_cursor_has_no_duplicates(client):
    _, auth = await account(client)
    for index in range(25):
        response = await community(client, auth, f"community-{index:02d}", f"Community {index:02d}")
        assert response.status_code == 201
    slugs = []
    cursor = None
    while True:
        params = {"limit": 10}
        if cursor:
            params["cursor"] = cursor
        page = (await client.get("/api/spaces", params=params)).json()
        slugs.extend(item["slug"] for item in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert len(slugs) == 25 and len(set(slugs)) == 25
    assert (await client.get("/api/spaces?limit=0")).status_code == 422


async def test_join_leave_and_workspace_domain(client):
    _, owner_auth = await account(client)
    _, member_auth = await account(client, "member")
    await community(client, owner_auth, "joinable")
    response = await client.post("/api/spaces/joinable/join", headers=member_auth)
    assert response.status_code == 200 and response.json()["my_role"] == "member"
    await client.post("/api/spaces/joinable/join", headers=member_auth)
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(SpaceMember)) == 2
    assert (await client.delete("/api/spaces/joinable/members/me", headers=owner_auth)).json() == {
        "detail": "Owner cannot leave"
    }
    assert (
        await client.delete("/api/spaces/joinable/members/me", headers=member_auth)
    ).status_code == 204
    await workspace(client, owner_auth, "acme-work", "acme.test")
    assert (await client.post("/api/spaces/acme-work/join", headers=member_auth)).status_code == 403
    _, acme_auth = await account(client, "acme", "employee@acme.test")
    assert (await client.post("/api/spaces/acme-work/join", headers=acme_auth)).status_code == 200
    mine = (await client.get("/api/me/spaces", headers=acme_auth)).json()
    assert [space["slug"] for space in mine] == ["acme-work"]


async def test_banned_member_cannot_join_or_view_workspace(client):
    _, owner_auth = await account(client)
    user, user_auth = await account(client, "banned")
    await workspace(client, owner_auth, "banned-work")
    async with SessionLocal() as session:
        space = await session.scalar(select(Space).where(Space.slug == "banned-work"))
        session.add(
            SpaceMember(
                space_id=space.id,
                user_id=user["user"]["id"],
                role=MemberRole.member,
                banned_until=datetime.now(UTC) + timedelta(days=1),
            )
        )
        await session.commit()
    assert (await client.get("/api/spaces/banned-work", headers=user_auth)).status_code == 404
    assert (await client.post("/api/spaces/banned-work/join", headers=user_auth)).status_code == 403


async def test_role_changes_and_kicks(client):
    _, owner = await account(client, "owner")
    _, admin = await account(client, "admin")
    _, moderator = await account(client, "moderator")
    _, _member = await account(client, "member")
    _, _guest = await account(client, "guest")
    await community(client, owner, "roles")
    async with SessionLocal() as session:
        space = await session.scalar(select(Space).where(Space.slug == "roles"))
        for name, role in [
            ("admin", MemberRole.admin),
            ("moderator", MemberRole.moderator),
            ("member", MemberRole.member),
            ("guest", MemberRole.guest),
        ]:
            target = await session.scalar(select(User).where(User.username == name))
            session.add(SpaceMember(space_id=space.id, user_id=target.id, role=role))
        await session.commit()
    async with SessionLocal() as session:
        users = {u.username: u.id for u in (await session.scalars(select(User))).all()}
    assert (
        await client.patch(
            f"/api/spaces/roles/members/{users['member']}",
            headers=admin,
            json={"role": "moderator"},
        )
    ).status_code == 200
    for role in ["admin", "owner"]:
        response = await client.patch(
            f"/api/spaces/roles/members/{users['guest']}", headers=admin, json={"role": role}
        )
        assert response.status_code == 403
    assert (
        await client.patch(
            f"/api/spaces/roles/members/{users['guest']}",
            headers=moderator,
            json={"role": "member"},
        )
    ).status_code == 403
    assert (
        await client.patch(
            f"/api/spaces/roles/members/{users['owner']}", headers=admin, json={"role": "member"}
        )
    ).status_code == 403
    assert (
        await client.delete(f"/api/spaces/roles/members/{users['guest']}", headers=moderator)
    ).status_code == 204
    assert (
        await client.delete(f"/api/spaces/roles/members/{users['admin']}", headers=moderator)
    ).status_code == 403


async def test_channels_access_unique_and_last_channel(client):
    _, owner = await account(client)
    _, member = await account(client, "member")
    await community(client, owner, "channels")
    _, other_owner = await account(client, "other")
    await community(client, other_owner, "other-channels")
    async with SessionLocal() as session:
        space = await session.scalar(select(Space).where(Space.slug == "channels"))
        other = await session.scalar(select(Space).where(Space.slug == "other-channels"))
        other_channel = await session.scalar(select(Channel).where(Channel.space_id == other.id))
        first_channel = await session.scalar(select(Channel).where(Channel.space_id == space.id))
        first_id, other_id = first_channel.id, other_channel.id
    path = "/api/spaces/channels/channels"
    created = await client.post(path, headers=owner, json={"name": "help"})
    assert created.status_code == 201 and created.json()["position"] == 1
    assert (await client.post(path, headers=owner, json={"name": "help"})).status_code == 409
    assert (await client.post(path, headers=member, json={"name": "locked"})).status_code == 403
    assert (
        await client.patch(f"{path}/{other_id}", headers=owner, json={"topic": "no"})
    ).status_code == 404
    assert (
        await client.patch(
            f"{path}/{created.json()['id']}",
            headers=owner,
            json={"position": 0, "topic": "A topic"},
        )
    ).json()["topic"] == "A topic"
    assert (await client.delete(f"{path}/{created.json()['id']}", headers=owner)).status_code == 204
    assert (await client.delete(f"{path}/{first_id}", headers=owner)).status_code == 409
    for body in [
        {"name": "Bad"},
        {"name": "two--words"},
        {"name": "a" * 81},
        {"name": "audio", "type": "announcement"},
    ]:
        assert (await client.post(path, headers=owner, json=body)).status_code == 422


async def test_edit_space_and_delete_permissions(client):
    _, owner = await account(client)
    _, admin = await account(client, "admin")
    _, member = await account(client, "member")
    await community(client, owner, "edit-space")
    async with SessionLocal() as session:
        space = await session.scalar(select(Space).where(Space.slug == "edit-space"))
        user = await session.scalar(select(User).where(User.username == "admin"))
        session.add(SpaceMember(space_id=space.id, user_id=user.id, role=MemberRole.admin))
        await session.commit()
    response = await client.patch(
        "/api/spaces/edit-space", headers=admin, json={"name": "Changed", "description": "Info"}
    )
    assert response.status_code == 200 and response.json()["name"] == "Changed"
    await client.post("/api/spaces/edit-space/join", headers=member)
    assert (
        await client.patch("/api/spaces/edit-space", headers=member, json={"name": "No"})
    ).status_code == 403
    assert (await client.delete("/api/spaces/edit-space", headers=admin)).status_code == 403
    assert (await client.delete("/api/spaces/edit-space", headers=owner)).status_code == 204
    assert (await client.get("/api/spaces/edit-space")).status_code == 404


async def test_company_domain_accepts_what_people_paste(client):
    _, auth = await account(client)
    pasted = ["Acme.com", "@acme.com", "you@Acme.com", "https://www.acme.com/about", " acme.com. "]
    for index, value in enumerate(pasted):
        response = await workspace(client, auth, f"paste-{index}", value)
        assert response.status_code == 201, (value, response.text)
        assert response.json()["allowed_email_domain"] == "acme.com"
    for index, value in enumerate(["gmail.com", "you@Outlook.com", "acme", "acme..com"]):
        response = await workspace(client, auth, f"reject-{index}", value)
        assert response.status_code == 422, value
    response = await workspace(client, auth, "empty-domain", "  ")
    assert response.status_code == 201 and response.json()["allowed_email_domain"] is None
