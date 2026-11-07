from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import (
    MemberRole,
    Prediction,
    Quiz,
    QuizAttempt,
    Space,
    SpaceMember,
    SpaceType,
    User,
)
from app.db.session import get_session
from app.games import leaderboard, predictions, trivia, words
from app.games.access import admin_space, play_space
from app.games.schemas import (
    AnswerIn,
    GuessIn,
    PredictionIn,
    QuestionIn,
    QuestionPatch,
    QuizIn,
    QuizPatch,
    StarterIn,
    VoteIn,
    WordState,
)
from app.spaces.permissions import ROLE_RANK

Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]

router = APIRouter(prefix="/spaces/{slug}/games", tags=["games"])
hub_router = APIRouter(prefix="/games", tags=["games"])


@hub_router.get("/hub")
async def hub(session: Session, user: CurrentUser):
    """The user's communities with their Daily Word state for today."""
    rows = (await session.execute(
        select(Space).join(SpaceMember, SpaceMember.space_id == Space.id)
        .where(SpaceMember.user_id == user.id, Space.type == SpaceType.community,
               SpaceMember.role != MemberRole.guest).order_by(Space.name))).scalars().all()
    items = []
    for space in rows:
        state = await words.today_state(session, space, user)
        items.append({"slug": space.slug, "name": space.name, "wordStatus": state.status,
                      "wordGuesses": len(state.guesses)})
    return items


@router.get("/summary")
async def summary(slug: str, session: Session, user: CurrentUser):
    space, member = await play_space(session, slug, user)
    state = await words.today_state(session, space, user)
    played = select(QuizAttempt.quiz_id).where(QuizAttempt.user_id == user.id)
    new_quizzes = await session.scalar(select(func.count()).select_from(Quiz).where(
        Quiz.space_id == space.id, Quiz.status == "published", Quiz.id.not_in(played)))
    open_predictions = await session.scalar(select(func.count()).select_from(Prediction).where(
        Prediction.space_id == space.id, Prediction.status == "open"))
    return {
        "word": {"status": state.status, "guesses": len(state.guesses)},
        "newQuizzes": new_quizzes, "openPredictions": open_predictions,
        "canManage": ROLE_RANK[member.role] >= ROLE_RANK[MemberRole.admin],
        "badges": {"topPlayer": user.id in await leaderboard.top_players(session, space.id),
                   "wordStreak": await words.streak(session, space.id, user.id)},
    }


# Daily Word ---------------------------------------------------------------------------------


@router.get("/word/today", response_model=WordState)
async def word_today(slug: str, session: Session, user: CurrentUser):
    space, _ = await play_space(session, slug, user)
    return await words.today_state(session, space, user)


@router.post("/word/guess", response_model=WordState)
async def word_guess(slug: str, data: GuessIn, session: Session, user: CurrentUser):
    space, _ = await play_space(session, slug, user)
    return await words.guess(session, space, user, data.guess)


# Trivia -------------------------------------------------------------------------------------


@router.get("/quizzes")
async def get_quizzes(slug: str, session: Session, user: CurrentUser):
    space, member = await play_space(session, slug, user)
    admin = ROLE_RANK[member.role] >= ROLE_RANK[MemberRole.admin]
    return await trivia.list_quizzes(session, space, user, admin=admin)


@router.post("/quizzes", status_code=201)
async def post_quiz(slug: str, data: QuizIn, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    quiz = await trivia.create_quiz(session, space, user, data)
    return await trivia.admin_detail(session, quiz, user)


@router.post("/quizzes/starter", status_code=201)
async def post_starter(slug: str, data: StarterIn, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    quiz = await trivia.create_starter(session, space, user, data.pack)
    return await trivia.admin_detail(session, quiz, user)


@router.get("/quizzes/{quiz_id}/admin")
async def get_quiz_admin(slug: str, quiz_id: str, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    return await trivia.admin_detail(session, await trivia.load_quiz(session, space, quiz_id), user)


@router.patch("/quizzes/{quiz_id}")
async def patch_quiz(slug: str, quiz_id: str, data: QuizPatch, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    quiz = await trivia.patch_quiz(session, await trivia.load_quiz(session, space, quiz_id), data)
    return await trivia.admin_detail(session, quiz, user)


@router.delete("/quizzes/{quiz_id}", status_code=204)
async def delete_quiz(slug: str, quiz_id: str, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    await session.delete(await trivia.load_quiz(session, space, quiz_id))
    await session.commit()


@router.post("/quizzes/{quiz_id}/publish")
async def publish_quiz(slug: str, quiz_id: str, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    quiz = await trivia.publish(session, await trivia.load_quiz(session, space, quiz_id))
    return await trivia.admin_detail(session, quiz, user)


@router.post("/quizzes/{quiz_id}/questions", status_code=201)
async def post_question(slug: str, quiz_id: str, data: QuestionIn, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    quiz = await trivia.load_quiz(session, space, quiz_id)
    await trivia.add_question(session, quiz, data)
    return await trivia.admin_detail(session, quiz, user)


@router.patch("/quizzes/{quiz_id}/questions/{question_id}")
async def patch_question(
    slug: str, quiz_id: str, question_id: str, data: QuestionPatch, session: Session, user: CurrentUser,
):
    space = await admin_space(session, slug, user)
    quiz = await trivia.load_quiz(session, space, quiz_id)
    await trivia.patch_question(session, quiz, question_id, data)
    return await trivia.admin_detail(session, quiz, user)


@router.delete("/quizzes/{quiz_id}/questions/{question_id}")
async def delete_question(slug: str, quiz_id: str, question_id: str, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    quiz = await trivia.load_quiz(session, space, quiz_id)
    await trivia.delete_question(session, quiz, question_id)
    return await trivia.admin_detail(session, quiz, user)


@router.post("/quizzes/{quiz_id}/start")
async def start_quiz(slug: str, quiz_id: str, session: Session, user: CurrentUser):
    space, _ = await play_space(session, slug, user)
    return await trivia.start(session, await trivia.load_quiz(session, space, quiz_id), user)


@router.post("/quizzes/{quiz_id}/answer")
async def answer_quiz(slug: str, quiz_id: str, data: AnswerIn, session: Session, user: CurrentUser):
    space, _ = await play_space(session, slug, user)
    return await trivia.answer(session, await trivia.load_quiz(session, space, quiz_id), user, data)


@router.post("/quizzes/{quiz_id}/finish")
async def finish_quiz(slug: str, quiz_id: str, session: Session, user: CurrentUser):
    space, _ = await play_space(session, slug, user)
    return await trivia.finish(session, await trivia.load_quiz(session, space, quiz_id), user)


# Predictions --------------------------------------------------------------------------------


@router.get("/predictions")
async def get_predictions(slug: str, session: Session, user: CurrentUser):
    space, _ = await play_space(session, slug, user)
    return await predictions.listing(session, space, user)


@router.post("/predictions", status_code=201)
async def post_prediction(slug: str, data: PredictionIn, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    created = await predictions.create(session, space, user, data)
    return next(item for item in await predictions.listing(session, space, user) if item["id"] == created.id)


@router.post("/predictions/{prediction_id}/vote", status_code=204)
async def vote_prediction(slug: str, prediction_id: str, data: VoteIn, session: Session, user: CurrentUser):
    space, _ = await play_space(session, slug, user)
    await predictions.vote(session, await predictions.load_prediction(session, space, prediction_id), user, data.optionId)


@router.post("/predictions/{prediction_id}/resolve")
async def resolve_prediction(slug: str, prediction_id: str, data: VoteIn, session: Session, user: CurrentUser):
    # Only owners and admins settle predictions: it hands out points, so moderators are left out.
    space = await admin_space(session, slug, user)
    prediction = await predictions.load_prediction(session, space, prediction_id)
    return {"winners": await predictions.resolve(session, prediction, data.optionId)}


@router.post("/predictions/{prediction_id}/cancel", status_code=204)
async def cancel_prediction(slug: str, prediction_id: str, session: Session, user: CurrentUser):
    space = await admin_space(session, slug, user)
    await predictions.cancel(session, await predictions.load_prediction(session, space, prediction_id))


# Leaderboard --------------------------------------------------------------------------------


@router.get("/leaderboard")
async def get_leaderboard(
    slug: str, session: Session, user: CurrentUser,
    period: Literal["daily", "weekly", "all"] = "weekly",
    game: Literal["daily_word", "trivia", "prediction"] | None = Query(default=None),
):
    space, _ = await play_space(session, slug, user)
    return await leaderboard.board(session, space.id, user.id, period, game)
