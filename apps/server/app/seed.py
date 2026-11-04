import asyncio
import secrets
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert

from app.auth.security import hash_password
from app.db.models import (
    Channel,
    ChannelType,
    DirectMember,
    Invite,
    MemberRole,
    Message,
    Reaction,
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
        conversations = [
            ("Welcome to Hive Developers! What are you building?", "A small recipe app in Python.", "Nice! I am working on its search page."),
            ("How is the new layout feeling?", "The channel sidebar is easier to scan.", "The amber accents look good on my phone."),
            ("I added a getting-started guide.", "The database setup section helped me.", "I will check the Windows instructions."),
            ("What should we discuss at the next meetup?", "Async Python would be useful.", "Could we cover connection pooling too?"),
            ("The community page is ready to try.", "I joined from the directory.", "The member count updated right away."),
            ("Please share any confusing error messages.", "A duplicate channel name now explains the problem.", "That should save a lot of debugging time."),
            ("I am reviewing our keyboard navigation.", "Tab reaches the channel buttons.", "Remember to keep a visible focus ring."),
            ("What editor shortcuts do you use most?", "Rename symbol is my favorite.", "Find references saves me every day."),
            ("The test database is separate from demo data.", "Great, my example spaces are still here.", "I checked that the test cleanup is isolated."),
            ("I opened a discussion on pagination.", "Cursor pagination seems like a good fit.", "Stable ordering matters when messages arrive together."),
            ("Has anyone tried the invite flow?", "The single-use link worked for me.", "Expired links show a clear error too."),
            ("I am polishing the mobile layout.", "The sidebar stacks above the conversation.", "Long words should wrap inside messages."),
            ("Any recommendations for our docs examples?", "Use small examples with expected output.", "A troubleshooting section would help newcomers."),
            ("The local health page is useful.", "I can see when Redis is unavailable.", "The round-trip measurement is handy too."),
            ("How should we organize support questions?", "Keep general discussion here.", "Specific questions can go in help."),
            ("I pushed a small accessibility improvement.", "The form labels are clearer now.", "I tested them with keyboard navigation."),
            ("We should test reconnect behavior today.", "I can simulate a network interruption.", "I will check that no messages are duplicated."),
            ("The demo seed can run more than once.", "That makes local setup much easier.", "I confirmed the example accounts stay consistent."),
            ("What did you learn this week?", "Postgres unique indexes can enforce retry safety.", "I learned how Socket.IO rooms work."),
            ("Thanks for trying the latest changes.", "The conversation feels much smoother.", "I will leave detailed feedback after lunch."),
        ]
        for channel_name, groups in [
            ("general", conversations),
            ("help", [("Where do I start?", "Read the local setup section in the README.",
                       "Thanks, the health page is green now!"),
                      ("Can I rerun the seed?", "Yes, it uses stable message identifiers.",
                       "Perfect, my demo history did not duplicate.")]),
        ]:
            channel = await session.scalar(select(Channel).where(
                Channel.space_id == seeded_spaces["hive-devs"].id, Channel.name == channel_name
            ))
            for group_index, group in enumerate(groups):
                for username, body in zip(("alice", "bob", "carol"), group, strict=True):
                    client_id = str(uuid5(NAMESPACE_URL, f"hive/{channel_name}/{group_index}/{username}"))
                    await session.execute(insert(Message).values(
                        channel_id=channel.id, author_id=accounts[username].id,
                        body=body, client_msg_id=client_id,
                    ).on_conflict_do_nothing(index_elements=["author_id", "client_msg_id"]))
        await seed_thread(session, seeded_spaces["hive-devs"].id, accounts)
        await seed_direct_messages(session, accounts)
        await session.commit()
    print(f"Acme invite: http://localhost:3000/invite/{code}")
    await engine.dispose()


async def seed_thread(session, space_id: str, accounts: dict) -> None:
    """A demo thread and reactions on the first #general message (idempotent)."""
    channel = await session.scalar(
        select(Channel).where(Channel.space_id == space_id, Channel.name == "general")
    )
    parent = await session.scalar(
        select(Message).where(Message.channel_id == channel.id, Message.parent_id.is_(None))
        .order_by(Message.id)
    )
    replies = [
        ("bob", "Mine is a CLI for tracking reading lists."),
        ("carol", "I am trying out a small chat bot for this server."),
        ("alice", "Both sound great. Post screenshots when you can!"),
    ]
    for index, (username, body) in enumerate(replies):
        await session.execute(insert(Message).values(
            channel_id=channel.id, author_id=accounts[username].id, parent_id=parent.id,
            body=body, client_msg_id=str(uuid5(NAMESPACE_URL, f"hive/thread/{index}")),
        ).on_conflict_do_nothing(index_elements=["author_id", "client_msg_id"]))
    count = select(func.count()).where(Message.parent_id == parent.id).scalar_subquery()
    await session.execute(update(Message).where(Message.id == parent.id).values(reply_count=count))
    for username, emoji in [("bob", "👋"), ("carol", "👋"), ("carol", "🎉")]:
        await session.execute(insert(Reaction).values(
            message_id=parent.id, user_id=accounts[username].id, emoji=emoji,
        ).on_conflict_do_nothing())



async def seed_direct_messages(session, accounts: dict) -> None:
    """A private chat between alice and bob and a group chat with carol (idempotent)."""
    conversations = {
        ("alice", "bob"): [
            ("bob", "Hey, do you have a minute to look at my pull request?"),
            ("alice", "Sure, send me the link."),
            ("bob", "Thanks! It is the pagination change."),
        ],
        ("alice", "bob", "carol"): [
            ("carol", "Shall we plan the next meetup here?"),
            ("alice", "Good idea. Friday evening works for me."),
            ("bob", "Friday is perfect."),
        ],
    }
    for people, messages in conversations.items():
        ids = sorted(accounts[name].id for name in people)
        key = ":".join(ids)
        await session.execute(
            insert(Channel).values(type=ChannelType.dm, name="dm", dm_key=key)
            .on_conflict_do_nothing(index_elements=["dm_key"])
        )
        channel = await session.scalar(select(Channel).where(Channel.dm_key == key))
        await session.execute(insert(DirectMember).values(
            [{"channel_id": channel.id, "user_id": user_id} for user_id in ids]
        ).on_conflict_do_nothing())
        for index, (username, body) in enumerate(messages):
            client_id = str(uuid5(NAMESPACE_URL, f"hive/dm/{'-'.join(people)}/{index}"))
            await session.execute(insert(Message).values(
                channel_id=channel.id, author_id=accounts[username].id, body=body,
                client_msg_id=client_id,
            ).on_conflict_do_nothing(index_elements=["author_id", "client_msg_id"]))

if __name__ == "__main__":
    asyncio.run(seed())
