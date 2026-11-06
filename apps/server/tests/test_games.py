from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select, update

from app.db.models import GameScore, QuizAttempt
from app.db.session import SessionLocal
from app.games import words


def base(slug="chat"):
    return f"/api/spaces/{slug}/games"


async def answer_of(space) -> str:
    return words.answer_for(space["id"], words.today())


def wrong_word(answer: str) -> str:
    return next(w for w in ("about", "above", "abuse") if w != answer)


def test_word_lists_are_clean():
    answers, valid = words.answers(), words.valid_words()
    assert len(answers) >= 500 and len(set(answers)) == len(answers)
    assert all(len(w) == 5 and w.isalpha() and w.islower() for w in valid)
    assert set(answers) <= valid


def test_answer_is_deterministic_and_varies():
    day = date(2026, 11, 5)
    assert words.answer_for("space-a", day) == words.answer_for("space-a", day)
    picks = {words.answer_for(f"space-{i}", day) for i in range(30)}
    assert len(picks) > 5
    assert len({words.answer_for("space-a", date(2026, 11, d)) for d in range(1, 29)}) > 5


def test_feedback_handles_duplicate_letters():
    states = lambda g, a: [c["state"] for c in words.feedback(g, a)]
    assert states("speed", "abide") == ["absent", "absent", "present", "absent", "present"]
    assert states("geese", "those") == ["absent", "absent", "absent", "correct", "correct"]
    assert states("llama", "hello") == ["present", "present", "absent", "absent", "absent"]
    assert states("crane", "crane") == ["correct"] * 5


async def test_word_flow_hides_answer_and_awards_points_once(client, setup_chat):
    _, _, _, _ah, bh, _, space, _ = setup_chat
    answer = await answer_of(space)
    state = (await client.get(f"{base()}/word/today", headers=bh)).json()
    assert state["status"] == "playing" and state["answer"] is None and state["guesses"] == []
    wrong = wrong_word(answer)
    first = await client.post(f"{base()}/word/guess", headers=bh, json={"guess": wrong.upper()})
    assert first.status_code == 200 and "answer" in first.json() and first.json()["answer"] is None
    assert answer not in first.text or answer == wrong
    won = (await client.post(f"{base()}/word/guess", headers=bh, json={"guess": answer})).json()
    assert won["status"] == "won" and won["answer"] == answer and won["points"] == 5
    assert won["share"].startswith(f"Hive Word {words.today()} 2/6")
    assert not any(ch.isalpha() for ch in won["share"].split("\n", 1)[1])
    again = await client.post(f"{base()}/word/guess", headers=bh, json={"guess": wrong})
    assert again.status_code == 409
    async with SessionLocal() as session:
        rows = list(await session.scalars(select(GameScore)))
    assert len(rows) == 1 and rows[0].points == 5 and rows[0].game == "daily_word"
    assert (await client.get(f"{base()}/word/today", headers=bh)).json()["status"] == "won"


async def test_word_validation_and_limits(client, setup_chat):
    _, _, _, _ah, bh, _, space, _ = setup_chat
    answer = await answer_of(space)
    bad = await client.post(f"{base()}/word/guess", headers=bh, json={"guess": "zzzzz"})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "not_a_word"
    assert (await client.post(f"{base()}/word/guess", headers=bh, json={"guess": "abc"})).status_code == 422
    pool = [w for w in ("about", "above", "abuse", "actor", "adapt", "added", "admit") if w != answer]
    for index in range(6):
        response = await client.post(f"{base()}/word/guess", headers=bh, json={"guess": pool[index]})
        assert response.status_code == 200
    last = response.json()
    assert last["status"] == "lost" and last["answer"] == answer and last["points"] is None
    assert (await client.post(f"{base()}/word/guess", headers=bh, json={"guess": pool[6]})).status_code == 409
    async with SessionLocal() as session:
        assert list(await session.scalars(select(GameScore))) == []


async def test_word_guess_rate_limit(client, setup_chat):
    _, _, _, _, bh, *_ = setup_chat
    codes = [(await client.post(f"{base()}/word/guess", headers=bh, json={"guess": "zzzzz"})).status_code
             for _ in range(61)]
    assert codes[:60] == [422] * 60 and codes[60] == 429


async def test_access_rules(client, setup_chat):
    _, _, _, ah, _bh, ch, *_ = setup_chat
    assert (await client.get(f"{base()}/word/today")).status_code == 401
    assert (await client.get(f"{base()}/word/today", headers=ch)).status_code == 404
    assert (await client.get(f"{base()}/leaderboard", headers=ch)).status_code == 404
    assert (await client.get(f"{base('nope')}/word/today", headers=ah)).status_code == 404


async def test_workspace_has_no_games(client, setup_chat):
    *_, ah, _, _, _, _ = setup_chat
    await client.post("/api/spaces", headers=ah, json={"type": "workspace", "name": "Work", "slug": "work"})
    assert (await client.get(f"{base('work')}/word/today", headers=ah)).status_code == 404
    assert (await client.get(f"{base('work')}/leaderboard", headers=ah)).status_code == 404


async def make_quiz(client, headers, questions=2, publish=True, slug="chat"):
    quiz = (await client.post(f"{base(slug)}/quizzes", headers=headers, json={"title": "Test quiz", "timeLimitS": 20})).json()
    for number in range(questions):
        await client.post(f"{base(slug)}/quizzes/{quiz['id']}/questions", headers=headers, json={
            "text": f"Question {number}?", "options": ["a", "b", "c", "d"], "correctIndex": number % 4})
    if publish:
        quiz = (await client.post(f"{base(slug)}/quizzes/{quiz['id']}/publish", headers=headers)).json()
    return quiz


async def test_quiz_permissions_and_drafts(client, setup_chat):
    _, _, _, ah, bh, *_ = setup_chat
    denied = await client.post(f"{base()}/quizzes", headers=bh, json={"title": "Nope"})
    assert denied.status_code == 403
    draft = await make_quiz(client, ah, publish=False)
    assert (await client.get(f"{base()}/quizzes", headers=bh)).json() == []
    assert len((await client.get(f"{base()}/quizzes", headers=ah)).json()) == 1
    assert (await client.post(f"{base()}/quizzes/{draft['id']}/start", headers=bh)).status_code == 404
    assert (await client.get(f"{base()}/quizzes/{draft['id']}/admin", headers=bh)).status_code == 403
    empty = (await client.post(f"{base()}/quizzes", headers=ah, json={"title": "Empty"})).json()
    assert (await client.post(f"{base()}/quizzes/{empty['id']}/publish", headers=ah)).status_code == 422


async def test_starter_pack_has_ten_questions(client, setup_chat):
    *_, ah, bh, _, _, _ = setup_chat
    response = await client.post(f"{base()}/quizzes/starter", headers=ah, json={"pack": "science"})
    assert response.status_code == 201 and len(response.json()["questions"]) == 10
    assert response.json()["status"] == "published"
    assert (await client.post(f"{base()}/quizzes/starter", headers=bh, json={"pack": "science"})).status_code == 403


async def test_quiz_play_scores_on_server(client, setup_chat):
    _, bob, _, ah, bh, *_ = setup_chat
    quiz = await make_quiz(client, ah, questions=3)
    started = (await client.post(f"{base()}/quizzes/{quiz['id']}/start", headers=bh)).json()
    assert all("correctIndex" not in q and "correct_index" not in q for q in started["questions"])
    again = (await client.post(f"{base()}/quizzes/{quiz['id']}/start", headers=bh)).json()
    assert again["attemptId"] == started["attemptId"]
    questions = started["questions"]
    out_of_order = await client.post(f"{base()}/quizzes/{quiz['id']}/answer", headers=bh,
                                     json={"questionId": questions[1]["id"], "choice": 1})
    assert out_of_order.status_code == 409
    for index, choice in ((0, 0), (1, 1), (2, 0)):  # the last one is wrong (answer is 2)
        response = await client.post(f"{base()}/quizzes/{quiz['id']}/answer", headers=bh,
                                     json={"questionId": questions[index]["id"], "choice": choice})
        assert response.status_code == 200 and response.json()["locked"] is True
        assert "correct" not in response.json()
    repeat = await client.post(f"{base()}/quizzes/{quiz['id']}/answer", headers=bh,
                               json={"questionId": questions[0]["id"], "choice": 0})
    assert repeat.status_code == 409
    result = (await client.post(f"{base()}/quizzes/{quiz['id']}/finish", headers=bh)).json()
    assert result["correctCount"] == 2 and 20 <= result["score"] <= 30
    assert [r["correctIndex"] for r in result["results"]] == [0, 1, 2]
    assert (await client.post(f"{base()}/quizzes/{quiz['id']}/start", headers=bh)).status_code == 409
    assert (await client.post(f"{base()}/quizzes/{quiz['id']}/finish", headers=bh)).json()["score"] == result["score"]
    async with SessionLocal() as session:
        scores = list(await session.scalars(select(GameScore).where(GameScore.user_id == bob["user"]["id"])))
    assert len(scores) == 1 and scores[0].points == result["score"]
    locked = await client.post(f"{base()}/quizzes/{quiz['id']}/questions", headers=ah, json={
        "text": "Late?", "options": ["a", "b", "c", "d"], "correctIndex": 0})
    assert locked.status_code == 409


async def test_late_answer_scores_zero(client, setup_chat):
    _, _, _, ah, bh, *_ = setup_chat
    quiz = await make_quiz(client, ah, questions=1)
    started = (await client.post(f"{base()}/quizzes/{quiz['id']}/start", headers=bh)).json()
    async with SessionLocal() as session:
        await session.execute(update(QuizAttempt).values(started_at=datetime.now(UTC) - timedelta(minutes=5)))
        await session.commit()
    response = await client.post(f"{base()}/quizzes/{quiz['id']}/answer", headers=bh,
                                 json={"questionId": started["questions"][0]["id"], "choice": 0})
    assert response.json()["late"] is True
    assert (await client.post(f"{base()}/quizzes/{quiz['id']}/finish", headers=bh)).json()["score"] == 0


async def test_quiz_in_other_community_is_not_found(client, setup_chat):
    _, _, _, ah, _bh, ch, *_ = setup_chat
    quiz = await make_quiz(client, ah)
    await client.post("/api/spaces", headers=ch, json={"type": "community", "name": "Other", "slug": "other"})
    assert (await client.post(f"{base('other')}/quizzes/{quiz['id']}/start", headers=ch)).status_code == 404


def soon(hours=1):
    return (datetime.now(UTC) + timedelta(hours=hours)).isoformat()


async def make_prediction(client, headers, hours=1):
    return (await client.post(f"{base()}/predictions", headers=headers, json={
        "question": "Who wins?", "options": ["Red", "Blue"], "closesAt": soon(hours), "points": 10})).json()


async def test_prediction_flow(client, setup_chat):
    _alice, bob, carol, ah, bh, ch, *_ = setup_chat
    await client.post("/api/spaces/chat/join", headers=ch)
    assert (await client.post(f"{base()}/predictions", headers=bh, json={
        "question": "x", "options": ["a", "b"], "closesAt": soon()})).status_code == 403
    assert (await client.post(f"{base()}/predictions", headers=ah, json={
        "question": "x", "options": ["a"], "closesAt": soon()})).status_code == 422
    assert (await client.post(f"{base()}/predictions", headers=ah, json={
        "question": "x", "options": ["a", "b"], "closesAt": soon(-1)})).status_code == 422
    prediction = await make_prediction(client, ah)
    red, blue = prediction["options"]
    for headers, option in ((bh, red), (ch, blue)):
        assert (await client.post(f"{base()}/predictions/{prediction['id']}/vote", headers=headers,
                                  json={"optionId": option["id"]})).status_code == 204
    # Votes can be changed until the prediction closes: carol switches to red.
    await client.post(f"{base()}/predictions/{prediction['id']}/vote", headers=ch, json={"optionId": red["id"]})
    listed = (await client.get(f"{base()}/predictions", headers=bh)).json()[0]
    assert [o["votes"] for o in listed["options"]] == [2, 0] and listed["myOptionId"] == red["id"]
    assert (await client.post(f"{base()}/predictions/{prediction['id']}/resolve", headers=bh,
                              json={"optionId": red["id"]})).status_code == 403
    resolved = await client.post(f"{base()}/predictions/{prediction['id']}/resolve", headers=ah, json={"optionId": red["id"]})
    assert resolved.json() == {"winners": 2}
    assert (await client.post(f"{base()}/predictions/{prediction['id']}/resolve", headers=ah,
                              json={"optionId": red["id"]})).status_code == 409
    assert (await client.post(f"{base()}/predictions/{prediction['id']}/vote", headers=bh,
                              json={"optionId": blue["id"]})).status_code == 409
    async with SessionLocal() as session:
        rows = list(await session.scalars(select(GameScore)))
    assert sorted(r.user_id for r in rows) == sorted([bob["user"]["id"], carol["user"]["id"]])
    assert all(r.points == 10 and r.game == "prediction" for r in rows)


async def test_prediction_cancel_and_closed_vote(client, setup_chat):
    *_, ah, bh, _, _, _ = setup_chat
    prediction = await make_prediction(client, ah)
    option = prediction["options"][0]
    await client.post(f"{base()}/predictions/{prediction['id']}/vote", headers=bh, json={"optionId": option["id"]})
    assert (await client.post(f"{base()}/predictions/{prediction['id']}/cancel", headers=ah)).status_code == 204
    assert (await client.post(f"{base()}/predictions/{prediction['id']}/cancel", headers=ah)).status_code == 409
    async with SessionLocal() as session:
        assert list(await session.scalars(select(GameScore))) == []
    closing = await make_prediction(client, ah)
    from app.db.models import Prediction
    async with SessionLocal() as session:
        await session.execute(update(Prediction).where(Prediction.id == closing["id"])
                              .values(closes_at=datetime.now(UTC) - timedelta(minutes=1)))
        await session.commit()
    late = await client.post(f"{base()}/predictions/{closing['id']}/vote", headers=bh,
                             json={"optionId": closing["options"][0]["id"]})
    assert late.status_code == 409


async def add_score(space_id, user_id, points, when, game="trivia"):
    async with SessionLocal() as session:
        session.add(GameScore(space_id=space_id, user_id=user_id, game=game, points=points, created_at=when))
        await session.commit()


async def test_leaderboard_periods_rank_and_badge(client, setup_chat):
    alice, bob, _carol, ah, bh, _ch, space, _ = setup_chat
    now = datetime.now(UTC)
    this_week = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    last_week = this_week - timedelta(days=3)
    await add_score(space["id"], bob["user"]["id"], 30, now)
    await add_score(space["id"], alice["user"]["id"], 20, now - timedelta(days=40))
    await add_score(space["id"], alice["user"]["id"], 5, last_week)
    await add_score(space["id"], bob["user"]["id"], 7, last_week, game="daily_word")

    def table(data):
        return [(e["user"]["username"], e["points"], e["rank"]) for e in data["entries"]]

    daily = (await client.get(f"{base()}/leaderboard?period=daily", headers=bh)).json()
    assert table(daily) == [("bob", 30, 1)] and daily["me"]["rank"] == 1
    alltime = (await client.get(f"{base()}/leaderboard?period=all", headers=ah)).json()
    assert table(alltime) == [("bob", 37, 1), ("alice", 25, 2)] and alltime["me"]["rank"] == 2
    only_trivia = (await client.get(f"{base()}/leaderboard?period=all&game=trivia", headers=ah)).json()
    assert table(only_trivia) == [("bob", 30, 1), ("alice", 25, 2)]
    assert "email" not in str(alltime)
    # The previous week's top players carry the badge.
    assert {e["user"]["username"]: e["topPlayer"] for e in alltime["entries"]} == {"bob": True, "alice": True}
    members = (await client.get("/api/spaces/chat/members", headers=ah)).json()["items"]
    assert {m["user"]["username"]: m["top_player"] for m in members}["bob"] is True
    summary = (await client.get(f"{base()}/summary", headers=bh)).json()
    assert summary["badges"]["topPlayer"] is True and summary["canManage"] is False
    assert (await client.get(f"{base()}/leaderboard?period=bogus", headers=ah)).status_code == 422


async def test_leaderboard_ignores_other_communities(client, setup_chat):
    _alice, _bob, carol, ah, _bh, ch, _space, _ = setup_chat
    other = (await client.post("/api/spaces", headers=ch, json={"type": "community", "name": "Other", "slug": "other"})).json()
    await add_score(other["id"], carol["user"]["id"], 99, datetime.now(UTC))
    data = (await client.get(f"{base()}/leaderboard?period=all", headers=ah)).json()
    assert data["entries"] == [] and data["me"] is None


async def test_hub_lists_my_communities(client, setup_chat):
    _, _, _, _ah, bh, ch, *_ = setup_chat
    hub = (await client.get("/api/games/hub", headers=bh)).json()
    assert [item["slug"] for item in hub] == ["chat"] and hub[0]["wordStatus"] == "playing"
    assert (await client.get("/api/games/hub", headers=ch)).json() == []
    assert (await client.get("/api/games/hub")).status_code == 401


@pytest.mark.parametrize("path", ["word/today", "quizzes", "predictions", "leaderboard", "summary"])
async def test_endpoints_require_login(client, setup_chat, path):
    assert (await client.get(f"{base()}/{path}")).status_code == 401
