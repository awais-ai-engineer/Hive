import asyncio
import secrets

from sqlalchemy import select

from app.auth.security import hash_password
from app.db.models import (
    Channel,
    ChannelType,
    Invite,
    MemberRole,
    Space,
    SpaceMember,
    SpaceType,
    User,
)
from app.db.session import SessionLocal, engine


async def seed() -> None:
    async with SessionLocal() as session:
        accounts = {}
        for username, email in [
            ("alice", "alice@hive.test"),
            ("bob", "bob@hive.test"),
            ("carol", "carol@hive.test"),
            ("dave", "dave@acme.test"),
        ]:
            user = await session.scalar(select(User).where(User.username == username))
            if user is None:
                user = User(
                    username=username, email=email, password_hash=hash_password("password123")
                )
                session.add(user)
                await session.flush()
            accounts[username] = user

        specifications = [
            (
                "hive-devs",
                "Hive Developers",
                SpaceType.community,
                None,
                "alice",
                [
                    ("general", ChannelType.text),
                    ("help", ChannelType.text),
                    ("showcase", ChannelType.text),
                    ("lounge", ChannelType.voice),
                ],
                {"bob": MemberRole.moderator, "carol": MemberRole.member},
            ),
            (
                "python-pk",
                "Python Pakistan",
                SpaceType.community,
                None,
                "bob",
                [("general", ChannelType.text), ("jobs", ChannelType.text)],
                {},
            ),
            (
                "acme",
                "Acme Team",
                SpaceType.workspace,
                "acme.test",
                "alice",
                [
                    ("general", ChannelType.text),
                    ("engineering", ChannelType.text),
                    ("random", ChannelType.text),
                ],
                {"dave": MemberRole.member},
            ),
        ]
        seeded_spaces = {}
        for slug, name, space_type, domain, owner_name, channels, memberships in specifications:
            space = await session.scalar(select(Space).where(Space.slug == slug))
            if space is None:
                space = Space(
                    type=space_type,
                    name=name,
                    slug=slug,
                    allowed_email_domain=domain,
                    created_by=accounts[owner_name].id,
                )
                session.add(space)
                await session.flush()
            else:
                space.name = name
                space.type = space_type
                space.allowed_email_domain = domain
            seeded_spaces[slug] = space
            roles = {owner_name: MemberRole.owner, **memberships}
            for username, role in roles.items():
                member = await session.get(SpaceMember, (space.id, accounts[username].id))
                if member is None:
                    session.add(
                        SpaceMember(space_id=space.id, user_id=accounts[username].id, role=role)
                    )
                else:
                    member.role = role
            for position, (channel_name, channel_type) in enumerate(channels):
                channel = await session.scalar(
                    select(Channel).where(
                        Channel.space_id == space.id, Channel.name == channel_name
                    )
                )
                if channel is None:
                    session.add(
                        Channel(
                            space_id=space.id,
                            name=channel_name,
                            type=channel_type,
                            position=position,
                        )
                    )
                else:
                    channel.type = channel_type
                    channel.position = position
        acme = seeded_spaces["acme"]
        invitation = await session.scalar(select(Invite).where(Invite.space_id == acme.id).limit(1))
        if invitation is None:
            invitation = Invite(
                space_id=acme.id, created_by=accounts["alice"].id, code=secrets.token_urlsafe(8)
            )
            session.add(invitation)
            await session.flush()
        code = invitation.code
        await session.commit()
    print(f"Acme invite: http://localhost:3000/invite/{code}")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed())
