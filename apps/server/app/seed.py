import asyncio
import secrets
from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from ulid import ULID

from app.auth.security import hash_password
from app.core.config import settings
from app.db.models import (
    Channel,
    ChannelMember,
    ChannelType,
    Comment,
    CommentVote,
    DirectMember,
    Invite,
    MemberRole,
    Message,
    Post,
    PostVote,
    Reaction,
    Space,
    SpaceMember,
    SpaceType,
    User,
    new_id,
)
from app.db.session import SessionLocal, engine
from app.posts.ranking import hot_score


async def seed_private_channel(session, acme: Space, accounts: dict) -> None:
    """A private "leadership" channel in acme for alice and dave (idempotent)."""
    channel = await session.scalar(
        select(Channel).where(Channel.space_id == acme.id, Channel.name == "leadership")
    )
    if channel is None:
        channel = Channel(space_id=acme.id, name="leadership", type=ChannelType.text,
                          position=10, is_private=True)
        session.add(channel)
        await session.flush()
    channel.is_private = True
    for username in ("alice", "dave"):
        if await session.get(ChannelMember, (channel.id, accounts[username].id)) is None:
            session.add(ChannelMember(channel_id=channel.id, user_id=accounts[username].id))


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
                {"alice": MemberRole.member, "carol": MemberRole.member},
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
        await seed_private_channel(session, acme, accounts)
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
        await seed_posts(session, seeded_spaces, accounts)
        await seed_discussion(session, seeded_spaces, accounts)
        await seed_media(session, seeded_spaces, accounts)
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

# (space, author, hours ago, title, body, url, {voter: value})
SEED_POSTS = [
    ("hive-devs", "alice", 2, "Show us what you are building this week", "Share a screenshot or a link, and one thing you got stuck on.", None, {"bob": 1}),
    ("hive-devs", "bob", 5, "Cursor pagination beats OFFSET for chat history", "OFFSET gets slower the deeper you page and skips rows when new messages arrive. Keyset cursors on a ULID stay fast and stable.", None, {"alice": 1, "carol": 1}),
    ("hive-devs", "carol", 9, "FastAPI documentation: dependencies with yield", None, "https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/", {"alice": 1}),
    ("hive-devs", "alice", 20, "What editor theme do you use?", None, None, {"bob": -1, "carol": 1}),
    ("hive-devs", "bob", 30, "How Socket.IO rooms scale with a Redis adapter", "Every instance publishes to Redis and only delivers to its own sockets. Rooms stay cheap because they are just sets per process.", None, {"alice": 1, "carol": 1}),
    ("hive-devs", "carol", 48, "PostgreSQL docs: row constructor comparison", None, "https://www.postgresql.org/docs/current/functions-comparisons.html", {"bob": 1}),
    ("hive-devs", "alice", 72, "Weekly help thread: ask anything", "No question is too small. Mention which part of the stack you are in.", None, {"bob": 1, "carol": 1}),
    ("hive-devs", "bob", 100, "Idempotent message sends with client IDs", "Generate a UUID in the browser, send it with the message, and put a unique index on (author, client id). Retries become harmless.", None, {"alice": 1, "carol": 1}),
    ("hive-devs", "carol", 140, "Tailwind v4 is out", None, "https://tailwindcss.com/blog/tailwindcss-v4", {"alice": -1}),
    ("hive-devs", "alice", 200, "Tabs or spaces?", None, None, {"bob": -1, "carol": -1}),
    ("hive-devs", "bob", 260, "Argon2id parameters for a small server", "Start with the library defaults, measure on your real hardware, and aim for roughly 50 ms per hash.", None, {"alice": 1}),
    ("hive-devs", "carol", 330, "My first open source pull request got merged", "It was a one-line docs fix, but it still counts!", None, {"alice": 1, "bob": 1}),
    ("hive-devs", "alice", 420, "Reading list: designing data-intensive applications", "Which chapter changed how you build things?", None, {"carol": 1}),
    ("hive-devs", "bob", 520, "Next.js App Router notes", None, "https://nextjs.org/docs/app", {}),
    ("hive-devs", "carol", 650, "Rate limiting with Redis INCR and EXPIRE", "A tiny Lua script keeps the increment and the expiry atomic.", None, {"alice": 1, "bob": 1}),
    ("python-pk", "bob", 3, "Python meetup in Lahore this Saturday", "Talks on async Python and testing. Everyone is welcome.", None, {"alice": 1, "carol": 1}),
    ("python-pk", "alice", 26, "Remote Python jobs thread", "Post roles you know about: company, stack, and whether juniors can apply.", None, {"bob": 1}),
    ("python-pk", "carol", 70, "uv: an extremely fast Python package manager", None, "https://docs.astral.sh/uv/", {"alice": 1, "bob": 1}),
    ("python-pk", "bob", 150, "Which testing library do you prefer?", None, None, {"carol": -1}),
    ("python-pk", "alice", 400, "Typing tips that caught real bugs", "TypedDict for JSON payloads and Literal for status strings found three bugs in our code.", None, {"bob": 1}),
]


async def seed_posts(session, spaces: dict, accounts: dict) -> None:
    """Demo posts spread over the last month with votes, so Hot, New and Top differ (idempotent)."""
    now = datetime.now(UTC)
    for slug, author, hours, title, body, url, votes in SEED_POSTS:
        space = spaces[slug]
        post = await session.scalar(select(Post).where(Post.space_id == space.id, Post.title == title))
        if post is None:
            created = now - timedelta(hours=hours)
            # The ULID id encodes the time, and "New" sorts by id, so it must match created_at.
            post = Post(id=str(ULID.from_datetime(created)), space_id=space.id,
                        author_id=accounts[author].id, title=title, body=body, url=url,
                        created_at=created)
            session.add(post)
            await session.flush()
        for voter, value in votes.items():
            await session.execute(insert(PostVote).values(
                post_id=post.id, user_id=accounts[voter].id, value=value,
            ).on_conflict_do_nothing())
        values = list(await session.scalars(select(PostVote.value).where(PostVote.post_id == post.id)))
        post.upvotes = values.count(1)
        post.downvotes = values.count(-1)
        post.score = post.upvotes - post.downvotes
        post.hot = hot_score(post.score, post.created_at)


async def seed_media(session, spaces, accounts):
    """Offline, repeatable PNG gallery for the developers community."""
    import struct
    import zlib

    from app.db.models import Attachment, Post
    from app.storage import get_storage

    title = "Our new office mascot sketches"
    post = await session.scalar(select(Post).where(Post.space_id == spaces["hive-devs"].id, Post.title == title))
    if post is None:
        post = Post(space_id=spaces["hive-devs"].id, author_id=accounts["alice"].id,
                    title=title, body="Two colour studies for our community mascot.")
        session.add(post)
        await session.flush()
        from app.posts.ranking import hot_score
        post.hot = hot_score(0, post.created_at)
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    for position, colour in enumerate([(251, 191, 36), (52, 211, 153)]):
        existing = await session.scalar(select(Attachment).where(Attachment.post_id == post.id, Attachment.position == position))
        if existing is not None:
            continue
        from app.db.models import new_id
        attachment_id = new_id()
        key = f"attachments/{attachment_id}"
        data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 160, 120, 8, 2, 0, 0, 0))
        data += chunk(b"IDAT", zlib.compress((b"\0" + bytes(colour) * 160) * 120)) + chunk(b"IEND", b"")
        async def chunks(payload=data):
            yield payload
        await get_storage().save(key, chunks(), "image/png")
        session.add(Attachment(id=attachment_id, space_id=spaces["hive-devs"].id, post_id=post.id,
            uploader_id=accounts["alice"].id, position=position, filename=f"mascot-{position + 1}.png",
            content_type="image/png", kind="image", size=len(data), storage_key=key))


# Comment trees: (post title, [(key, parent key, author, body, {voter: value})]).
SEED_COMMENTS = [
    ("Cursor pagination beats OFFSET for chat history", [
        ("a", None, "alice", "This bit us in production: page 40 took seconds with OFFSET.", {"bob": 1, "carol": 1}),
        ("a1", "a", "bob", "Did you index (channel_id, id) or only id?", {"alice": 1}),
        ("a1a", "a1", "alice", "Composite index. Single-column was not enough for the filter.", {"bob": 1, "carol": 1}),
        ("a1a1", "a1a", "carol", "Same here; EXPLAIN showed an index-only scan afterwards.", {}),
        ("b", None, "carol", "How do you jump to an exact message, like a permalink?", {"alice": 1}),
        ("b1", "b", "bob", "Load the page around it with before= and after= cursors.", {"carol": 1}),
        ("c", None, "bob", "Offsets are fine for admin tables with small data.", {"alice": -1}),
        ("c1", "c", "carol", "True, as long as nothing is inserted while you page.", {}),
    ]),
    ("Show us what you are building this week", [
        ("a", None, "bob", "A CLI that turns my reading list into weekly emails.", {"alice": 1, "carol": 1}),
        ("a1", "a", "alice", "Nice! Which library sends the emails?", {}),
        ("a1a", "a1", "bob", "Plain SMTP for now, maybe a provider later.", {"alice": 1}),
        ("b", None, "carol", "A tiny bot that welcomes new members in #general.", {"alice": 1, "bob": 1}),
        ("b1", "b", "alice", "Ship it to Hive Developers when it's ready!", {"carol": 1}),
        ("b1a", "b1", "carol", "Will do, after rate limiting is in place.", {}),
        ("x", None, "alice", "Removed by the author.", {}),
        ("x1", "x", "bob", "Replies stay readable even when the parent is deleted.", {"carol": 1}),
    ]),
    ("Idempotent message sends with client IDs", [
        ("a", None, "carol", "Do you also dedupe on the server when the client retries after a timeout?", {"alice": 1}),
        ("a1", "a", "bob", "Yes, the unique index does that: the retry gets the original message back.", {"alice": 1, "carol": 1}),
        ("a1a", "a1", "carol", "And no second broadcast, right?", {}),
        ("a1a1", "a1a", "alice", "Right, only the first insert broadcasts.", {"carol": 1}),
        ("b", None, "alice", "UUIDv4 from crypto.randomUUID() is enough for this.", {"bob": 1}),
        ("c", None, "bob", "Bonus: it makes optimistic UI easy to reconcile.", {"alice": 1, "carol": 1}),
        ("c1", "c", "carol", "Match pending messages by client id when the ack arrives.", {}),
        ("d", None, "carol", "Great write-up, thanks!", {}),
        ("d1", "d", "bob", "Glad it helped.", {}),
    ]),
]
DELETED_COMMENT = ("Show us what you are building this week", "x")


async def seed_discussion(session, spaces: dict, accounts: dict) -> None:
    """Comment trees, one repost and a shared post link in chat (idempotent)."""
    devs = spaces["hive-devs"]
    for title, comments in SEED_COMMENTS:
        post = await session.scalar(select(Post).where(Post.space_id == devs.id, Post.title == title))
        created: dict[str, Comment] = {}
        for key, parent_key, author, body, votes in comments:
            parent = created.get(parent_key) if parent_key else None
            comment = await session.scalar(select(Comment).where(
                Comment.post_id == post.id, Comment.author_id == accounts[author].id,
                Comment.parent_id == (parent.id if parent else None) if parent else Comment.parent_id.is_(None),
                Comment.body == body,
            )) if (title, key) != DELETED_COMMENT else await session.scalar(select(Comment).where(
                Comment.post_id == post.id, Comment.author_id == accounts[author].id,
                Comment.parent_id.is_(None), Comment.deleted_at.is_not(None),
            ))
            if comment is None:
                comment_id = new_id()
                comment = Comment(
                    id=comment_id, post_id=post.id, author_id=accounts[author].id,
                    parent_id=parent.id if parent else None,
                    path=f"{parent.path}.{comment_id}" if parent else comment_id,
                    depth=parent.depth + 1 if parent else 0, body=body,
                )
                session.add(comment)
                await session.flush()
            created[key] = comment
            for voter, value in votes.items():
                await session.execute(insert(CommentVote).values(
                    comment_id=comment.id, user_id=accounts[voter].id, value=value,
                ).on_conflict_do_nothing())
        deleted = created.get(DELETED_COMMENT[1]) if title == DELETED_COMMENT[0] else None
        if deleted is not None and deleted.deleted_at is None:
            deleted.deleted_at = datetime.now(UTC)
            deleted.body = None
        await session.flush()
        # Recompute every counter from the data so reruns stay consistent.
        for comment in created.values():
            values = list(await session.scalars(
                select(CommentVote.value).where(CommentVote.comment_id == comment.id)
            ))
            comment.upvotes, comment.downvotes = values.count(1), values.count(-1)
            comment.score = comment.upvotes - comment.downvotes
            comment.reply_count = await session.scalar(select(func.count()).where(
                Comment.parent_id == comment.id, Comment.deleted_at.is_(None)
            ))
        post.comment_count = await session.scalar(select(func.count()).where(
            Comment.post_id == post.id, Comment.deleted_at.is_(None)
        ))

    # One repost of a Hive Developers post into Python Pakistan.
    original = await session.scalar(select(Post).where(
        Post.space_id == devs.id, Post.title == "Idempotent message sends with client IDs"))
    target = spaces["python-pk"]
    await session.execute(insert(Post).values(
        id=new_id(), space_id=target.id, author_id=accounts["carol"].id, title=original.title,
        repost_of_id=original.id,
    ).on_conflict_do_nothing(constraint="posts_repost_once"))
    await session.flush()
    original.repost_count = await session.scalar(select(func.count()).where(
        Post.repost_of_id == original.id, Post.deleted_at.is_(None)))
    repost = await session.scalar(select(Post).where(
        Post.repost_of_id == original.id, Post.space_id == target.id))
    repost.hot = hot_score(repost.score, repost.created_at)

    # A chat message sharing a post link, so the preview card shows in #general.
    general = await session.scalar(select(Channel).where(
        Channel.space_id == devs.id, Channel.name == "general"))
    link = f"{settings.web_origin}/p/{original.id}"
    await session.execute(insert(Message).values(
        channel_id=general.id, author_id=accounts["bob"].id,
        body=f"Worth a read before we touch the composer again: {link}",
        client_msg_id=str(uuid5(NAMESPACE_URL, "hive/share/idempotent-sends")),
    ).on_conflict_do_nothing(index_elements=["author_id", "client_msg_id"]))


if __name__ == "__main__":
    asyncio.run(seed())
