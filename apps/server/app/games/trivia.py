"""Trivia: admins write quizzes, members play each one once. Answers stay on the server until
the attempt is finished."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.limits import hit
from app.db.models import (
    GameScore,
    Quiz,
    QuizAnswer,
    QuizAttempt,
    QuizQuestion,
    Space,
    User,
    new_id,
)
from app.games.schemas import AnswerIn, QuestionIn, QuestionPatch, QuizIn, QuizPatch

POINTS_PER_CORRECT = 10
MAX_SPEED_BONUS = 5
GRACE = timedelta(seconds=2)
MAX_QUESTIONS = 30
STARTERS = json.loads((Path(__file__).parent / "starter_quizzes.json").read_text(encoding="utf-8"))


async def load_quiz(session: AsyncSession, space: Space, quiz_id: str) -> Quiz:
    quiz = await session.get(Quiz, quiz_id)
    if quiz is None or quiz.space_id != space.id:
        raise HTTPException(404, "Quiz not found")
    return quiz


async def questions_of(session: AsyncSession, quiz_id: str) -> list[QuizQuestion]:
    return list(await session.scalars(
        select(QuizQuestion).where(QuizQuestion.quiz_id == quiz_id).order_by(QuizQuestion.position)))


def _question_out(question: QuizQuestion, *, reveal: bool) -> dict:
    out = {"id": question.id, "position": question.position, "text": question.text,
           "options": question.options}
    if reveal:
        out["correctIndex"] = question.correct_index
    return out


async def quiz_out(session: AsyncSession, quiz: Quiz, user: User, *, admin: bool) -> dict:
    count = await session.scalar(
        select(func.count()).select_from(QuizQuestion).where(QuizQuestion.quiz_id == quiz.id))
    attempt = await _attempt(session, quiz, user)
    state = "new" if attempt is None else "finished" if attempt.finished_at else "playing"
    return {"id": quiz.id, "title": quiz.title, "timeLimitS": quiz.time_limit_s, "status": quiz.status,
            "questionCount": count, "myState": state, "myScore": attempt.score if attempt else None,
            "canEdit": admin}


async def list_quizzes(session: AsyncSession, space: Space, user: User, *, admin: bool) -> list[dict]:
    query = select(Quiz).where(Quiz.space_id == space.id).order_by(Quiz.id.desc()).limit(100)
    query = query.where(Quiz.status != "archived") if admin else query.where(Quiz.status == "published")
    return [await quiz_out(session, quiz, user, admin=admin) for quiz in await session.scalars(query)]


async def admin_detail(session: AsyncSession, quiz: Quiz, user: User) -> dict:
    out = await quiz_out(session, quiz, user, admin=True)
    out["questions"] = [_question_out(q, reveal=True) for q in await questions_of(session, quiz.id)]
    return out


async def create_quiz(session: AsyncSession, space: Space, user: User, data: QuizIn) -> Quiz:
    quiz = Quiz(space_id=space.id, created_by=user.id, title=data.title, time_limit_s=data.timeLimitS)
    session.add(quiz)
    await session.commit()
    return quiz


async def create_starter(session: AsyncSession, space: Space, user: User, pack: str) -> Quiz:
    data = STARTERS[pack]
    quiz = Quiz(id=new_id(), space_id=space.id, created_by=user.id, title=data["title"],
                time_limit_s=20, status="published")
    session.add(quiz)
    await session.flush()
    session.add_all([
        QuizQuestion(quiz_id=quiz.id, position=i, text=q["text"], options=q["options"],
                     correct_index=q["correct"]) for i, q in enumerate(data["questions"])])
    await session.commit()
    return quiz


async def _editable(session: AsyncSession, quiz: Quiz) -> None:
    started = await session.scalar(select(func.count()).select_from(QuizAttempt).where(
        QuizAttempt.quiz_id == quiz.id))
    if started:
        raise HTTPException(409, "People have already played this quiz, so its questions are locked.")


async def patch_quiz(session: AsyncSession, quiz: Quiz, data: QuizPatch) -> Quiz:
    if data.title is not None:
        quiz.title = data.title
    if data.timeLimitS is not None:
        await _editable(session, quiz)
        quiz.time_limit_s = data.timeLimitS
    if data.status is not None:
        quiz.status = data.status
    await session.commit()
    return quiz


async def publish(session: AsyncSession, quiz: Quiz) -> Quiz:
    if not await questions_of(session, quiz.id):
        raise HTTPException(422, "Add at least one question before publishing.")
    quiz.status = "published"
    await session.commit()
    return quiz


async def add_question(session: AsyncSession, quiz: Quiz, data: QuestionIn) -> QuizQuestion:
    await _editable(session, quiz)
    existing = await questions_of(session, quiz.id)
    if len(existing) >= MAX_QUESTIONS:
        raise HTTPException(422, f"A quiz can have at most {MAX_QUESTIONS} questions.")
    question = QuizQuestion(quiz_id=quiz.id, position=(existing[-1].position + 1) if existing else 0,
                            text=data.text, options=data.options, correct_index=data.correctIndex)
    session.add(question)
    await session.commit()
    return question


async def question_of(session: AsyncSession, quiz: Quiz, question_id: str) -> QuizQuestion:
    question = await session.get(QuizQuestion, question_id)
    if question is None or question.quiz_id != quiz.id:
        raise HTTPException(404, "Question not found")
    return question


async def patch_question(session: AsyncSession, quiz: Quiz, question_id: str, data: QuestionPatch):
    await _editable(session, quiz)
    question = await question_of(session, quiz, question_id)
    if data.text is not None:
        question.text = data.text
    if data.options is not None:
        question.options = data.options
    if data.correctIndex is not None:
        question.correct_index = data.correctIndex
    await session.commit()
    return question


async def delete_question(session: AsyncSession, quiz: Quiz, question_id: str) -> None:
    await _editable(session, quiz)
    await session.delete(await question_of(session, quiz, question_id))
    await session.commit()


# Playing ------------------------------------------------------------------------------------


async def _attempt(session: AsyncSession, quiz: Quiz, user: User, *, lock: bool = False):
    query = select(QuizAttempt).where(QuizAttempt.quiz_id == quiz.id, QuizAttempt.user_id == user.id)
    return await session.scalar(query.with_for_update() if lock else query)


def _require_published(quiz: Quiz) -> None:
    if quiz.status != "published":
        raise HTTPException(404, "Quiz not found")


async def start(session: AsyncSession, quiz: Quiz, user: User) -> dict:
    _require_published(quiz)
    questions = await questions_of(session, quiz.id)
    if not questions:
        raise HTTPException(404, "Quiz not found")
    attempt = await _attempt(session, quiz, user)
    if attempt is None:
        try:
            attempt = QuizAttempt(quiz_id=quiz.id, user_id=user.id, started_at=datetime.now(UTC))
            session.add(attempt)
            await session.commit()
        except IntegrityError:  # two requests raced: keep the first attempt
            await session.rollback()
            attempt = await _attempt(session, quiz, user)
    if attempt.finished_at is not None:
        raise HTTPException(409, "You already played this quiz.")
    answered = list(await session.scalars(
        select(QuizAnswer.question_id).where(QuizAnswer.attempt_id == attempt.id)))
    return {"attemptId": attempt.id, "startedAt": attempt.started_at, "timeLimitS": quiz.time_limit_s,
            "questions": [_question_out(q, reveal=False) for q in questions],
            "answeredIds": sorted(answered)}


async def _timeline(session: AsyncSession, attempt: QuizAttempt) -> list[QuizAnswer]:
    return list(await session.scalars(
        select(QuizAnswer).where(QuizAnswer.attempt_id == attempt.id).order_by(QuizAnswer.answered_at)))


async def answer(session: AsyncSession, quiz: Quiz, user: User, data: AnswerIn) -> dict:
    """Questions are answered in order. The clock for each starts when the previous one was
    answered (or the attempt began) and the server's clock decides what counts as late."""
    _require_published(quiz)
    await hit(f"rl:games:{user.id}", 120, 60, "Too many answers, wait a moment")
    attempt = await _attempt(session, quiz, user, lock=True)
    if attempt is None:
        raise HTTPException(409, "Start the quiz first.")
    if attempt.finished_at is not None:
        raise HTTPException(409, "You already finished this quiz.")
    done = await _timeline(session, attempt)
    questions = await questions_of(session, quiz.id)
    if any(item.question_id == data.questionId for item in done):
        raise HTTPException(409, "You already answered this question.")
    if len(done) >= len(questions) or questions[len(done)].id != data.questionId:
        raise HTTPException(409, "Answer the questions in order.")
    now = datetime.now(UTC)
    opened = done[-1].answered_at if done else attempt.started_at
    late = now - opened > timedelta(seconds=quiz.time_limit_s) + GRACE
    session.add(QuizAnswer(attempt_id=attempt.id, question_id=data.questionId,
                           choice=None if late else data.choice, answered_at=now))
    await session.commit()
    return {"locked": True, "late": late, "remaining": len(questions) - len(done) - 1}


async def finish(session: AsyncSession, quiz: Quiz, user: User) -> dict:
    _require_published(quiz)
    attempt = await _attempt(session, quiz, user, lock=True)
    if attempt is None:
        raise HTTPException(409, "Start the quiz first.")
    questions = await questions_of(session, quiz.id)
    done = await _timeline(session, attempt)
    if attempt.finished_at is None:
        opened = attempt.started_at
        score = 0
        by_question = {item.question_id: item for item in done}
        for question in questions:
            item = by_question.get(question.id)
            if item is None:
                continue
            elapsed = max(0.0, (item.answered_at - opened).total_seconds())
            opened = item.answered_at
            if item.choice == question.correct_index:
                left = max(0.0, 1 - elapsed / quiz.time_limit_s)
                score += POINTS_PER_CORRECT + int(MAX_SPEED_BONUS * left)
        now = datetime.now(UTC)
        for question in questions:
            if question.id not in by_question:
                session.add(QuizAnswer(attempt_id=attempt.id, question_id=question.id, choice=None,
                                       answered_at=now))
        attempt.finished_at = now
        attempt.score = score
        session.add(GameScore(space_id=quiz.space_id, user_id=user.id, game="trivia",
                              points=score, ref_id=attempt.id))
        await session.commit()
        done = await _timeline(session, attempt)
    choices = {item.question_id: item.choice for item in done}
    results = [{**_question_out(q, reveal=True), "choice": choices.get(q.id),
                "correct": choices.get(q.id) == q.correct_index} for q in questions]
    return {"score": attempt.score, "correctCount": sum(r["correct"] for r in results),
            "total": len(questions), "results": results}
