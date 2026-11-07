"""Ask Hive: full-text search over what the user may read, then an answer that cites it."""

import re

from sqlalchemy import func, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.prompt import clean_line, wrap
from app.ai.service import call_model
from app.db.models import Channel, Comment, Message, Post, Space, SpaceMember, SpaceType, User
from app.messages.threads import my_channel_ids
from app.users.blocks import not_blocked_with

LIMIT = 12
NOTHING = "I couldn't find anything about that in the places you can access."
TASK = (
    "You answer questions about a team's conversations and posts. You are given numbered sources "
    "such as `[2] title: text`. Answer only from those sources, in a few short sentences, and cite "
    "the sources you used by number in square brackets, for example [1][3]. If the sources do not "
    "contain the answer, say so plainly."
)


def vector(column):
    return func.to_tsvector(literal_column("'simple'"), column)


async def search(session: AsyncSession, user: User, question: str, space_id: str | None) -> list[dict]:
    query = func.websearch_to_tsquery(literal_column("'simple'"), question)
    found: list[dict] = []

    mine = select(my_channel_ids(user.id).c.id)
    statement = (
        select(Message, User, Channel, func.ts_rank(vector(Message.body), query).label("rank"))
        .join(User, User.id == Message.author_id).join(Channel, Channel.id == Message.channel_id)
        .where(Message.channel_id.in_(mine), Message.deleted_at.is_(None),
               Message.kind.in_(("text", "poll")), vector(Message.body).op("@@")(query),
               not_blocked_with(user.id))
        .order_by(literal_column("rank").desc()).limit(LIMIT)
    )
    if space_id:
        statement = statement.where(Channel.space_id == space_id)
    for message, author, channel, rank in (await session.execute(statement)).all():
        found.append({"type": "message", "id": message.id, "rank": rank, "text": message.body,
                      "title": f"{author.username} in #{channel.name}",
                      "url": f"/home?c={channel.id}&m={message.id}"})

    member_spaces = select(SpaceMember.space_id).where(SpaceMember.user_id == user.id)
    reachable = or_(Space.type == SpaceType.community, Space.id.in_(member_spaces))
    scope = [reachable, Space.id == space_id] if space_id else [reachable]
    post_hit = or_(vector(Post.title).op("@@")(query), vector(func.coalesce(Post.body, "")).op("@@")(query))
    post_rank = func.ts_rank(vector(Post.title), query) + func.ts_rank(vector(func.coalesce(Post.body, "")), query)
    rows = await session.execute(
        select(Post, post_rank.label("rank")).join(Space, Space.id == Post.space_id)
        .join(User, User.id == Post.author_id)
        .where(*scope, Post.deleted_at.is_(None), post_hit, not_blocked_with(user.id))
        .order_by(literal_column("rank").desc()).limit(LIMIT))
    for post, rank in rows.all():
        found.append({"type": "post", "id": post.id, "rank": rank, "title": post.title,
                      "text": f"{post.title}. {post.body or ''}", "url": f"/p/{post.id}"})

    rows = await session.execute(
        select(Comment, Post, func.ts_rank(vector(func.coalesce(Comment.body, "")), query).label("rank"))
        .join(Post, Post.id == Comment.post_id).join(Space, Space.id == Post.space_id)
        .join(User, User.id == Comment.author_id)
        .where(*scope, Comment.deleted_at.is_(None), Post.deleted_at.is_(None),
               vector(func.coalesce(Comment.body, "")).op("@@")(query), not_blocked_with(user.id))
        .order_by(literal_column("rank").desc()).limit(LIMIT))
    for comment, post, rank in rows.all():
        found.append({"type": "comment", "id": comment.id, "rank": rank, "title": f"Comment on {post.title}",
                      "text": comment.body or "", "url": f"/p/{post.id}"})
    found.sort(key=lambda item: item["rank"], reverse=True)
    return found[:LIMIT]


async def ask(session: AsyncSession, user: User, question: str, space_id: str | None) -> dict:
    found = await search(session, user, question, space_id)
    if not found:
        return {"answer": NOTHING, "sources": []}
    numbered = {n: item for n, item in enumerate(found, start=1)}
    block = "\n".join(f"[{n}] {clean_line(item['title'], 120)}: {clean_line(item['text'], 600)}"
                      for n, item in numbered.items())
    prompt = f"Question: {clean_line(question, 500)}\n\nSources:\n{wrap(block)}"
    result = await call_model(session, user, "ask", TASK, prompt, space_id=space_id)

    def keep(match: re.Match) -> str:
        return match.group(0) if int(match.group(1)) in numbered else ""

    answer = re.sub(r"\[(\d{1,3})\]", keep, result.text).strip()
    cited = list(dict.fromkeys(int(n) for n in re.findall(r"\[(\d{1,3})\]", answer)))
    return {"answer": answer, "sources": [
        {"n": n, "type": numbered[n]["type"], "id": numbered[n]["id"], "title": numbered[n]["title"],
         "url": numbered[n]["url"], "snippet": clean_line(numbered[n]["text"], 160)} for n in cited]}

