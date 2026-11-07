"""Daily Word: one shared five-letter puzzle per community per UTC day."""

import hashlib
import re
from datetime import UTC, date, datetime
from functools import cache
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.limits import hit
from app.db.models import GameScore, Space, User, WordAttempt
from app.games.schemas import WordState

MAX_GUESSES = 6
_DIR = Path(__file__).parent


@cache
def answers() -> list[str]:
    return (_DIR / "words_answers.txt").read_text().split()


@cache
def valid_words() -> frozenset[str]:
    return frozenset((_DIR / "words_valid.txt").read_text().split()) | frozenset(answers())


def today() -> date:
    return datetime.now(UTC).date()


def answer_for(space_id: str, day: date) -> str:
    digest = hashlib.sha256(f"{settings.game_secret}:{space_id}:{day}".encode()).hexdigest()
    words = answers()
    return words[int(digest, 16) % len(words)]


def feedback(guess: str, answer: str) -> list[dict]:
    """Per-letter result; repeated letters are only marked as often as they occur in the answer."""
    states = ["absent"] * len(guess)
    spare: dict[str, int] = {}
    for i, letter in enumerate(answer):
        if guess[i] == letter:
            states[i] = "correct"
        else:
            spare[letter] = spare.get(letter, 0) + 1
    for i, letter in enumerate(guess):
        if states[i] != "correct" and spare.get(letter, 0) > 0:
            states[i] = "present"
            spare[letter] -= 1
    return [{"letter": letter, "state": state} for letter, state in zip(guess, states, strict=True)]


def share_text(day: date, guesses: list[dict], solved: bool) -> str:
    marks = {"correct": "🟩", "present": "🟨", "absent": "⬛"}
    score = len(guesses) if solved else "X"
    rows = ["".join(marks[cell["state"]] for cell in row) for row in guesses]
    return "\n".join([f"Hive Word {day} {score}/{MAX_GUESSES}", *rows])


def _state(attempt: WordAttempt | None, space_id: str, day: date) -> WordState:
    words = attempt.guesses if attempt else []
    answer = answer_for(space_id, day)
    rows = [feedback(word, answer) for word in words]
    finished = attempt is not None and attempt.finished_at is not None
    solved = bool(attempt and attempt.solved)
    return WordState(
        day=str(day), guesses=rows, status="won" if solved else "lost" if finished else "playing",
        maxGuesses=MAX_GUESSES, answer=answer if finished else None,
        points=(MAX_GUESSES + 1 - len(words)) if solved else None,
        share=share_text(day, rows, solved) if finished else None,
    )


async def today_state(session: AsyncSession, space: Space, user: User) -> WordState:
    day = today()
    attempt = await session.scalar(select(WordAttempt).where(
        WordAttempt.space_id == space.id, WordAttempt.user_id == user.id, WordAttempt.day == day))
    return _state(attempt, space.id, day)


async def guess(session: AsyncSession, space: Space, user: User, text: str) -> WordState:
    await hit(f"rl:games:{user.id}", 60, 60, "Too many guesses, wait a moment")
    word = text.strip().lower()
    if not re.fullmatch(r"[a-z]{5}", word):
        raise HTTPException(422, detail={"code": "invalid_guess", "message": "Guesses are five letters, a to z."})
    if word not in valid_words():
        raise HTTPException(422, detail={"code": "not_a_word", "message": "That word is not in our word list."})
    day = today()
    await session.execute(insert(WordAttempt).values(
        space_id=space.id, user_id=user.id, day=day, guesses=[]).on_conflict_do_nothing())
    attempt = await session.scalar(select(WordAttempt).where(
        WordAttempt.space_id == space.id, WordAttempt.user_id == user.id, WordAttempt.day == day,
    ).with_for_update())
    if attempt.finished_at is not None:
        raise HTTPException(409, detail={"code": "finished", "message": "Today's word is finished. Come back tomorrow."})
    attempt.guesses = [*attempt.guesses, word]
    solved = word == answer_for(space.id, day)
    if solved or len(attempt.guesses) >= MAX_GUESSES:
        attempt.finished_at = datetime.now(UTC)
        attempt.solved = solved
        if solved:
            session.add(GameScore(space_id=space.id, user_id=user.id, game="daily_word",
                                  points=MAX_GUESSES + 1 - len(attempt.guesses), ref_id=attempt.id))
    await session.commit()
    return _state(attempt, space.id, day)


async def streak(session: AsyncSession, space_id: str, user_id: str) -> int:
    """Consecutive days solved, counting back from today (or yesterday if today isn't solved yet)."""
    days = list(await session.scalars(select(WordAttempt.day).where(
        WordAttempt.space_id == space_id, WordAttempt.user_id == user_id, WordAttempt.solved.is_(True),
    ).order_by(WordAttempt.day.desc()).limit(400)))
    if not days:
        return 0
    cursor = today()
    if days[0] != cursor:
        cursor = date.fromordinal(cursor.toordinal() - 1)
    count = 0
    for day in days:
        if day != cursor:
            break
        count += 1
        cursor = date.fromordinal(cursor.toordinal() - 1)
    return count
