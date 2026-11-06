from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints

Text200 = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Title80 = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


class GuessIn(BaseModel):
    guess: str = Field(max_length=32)


class Letter(BaseModel):
    letter: str
    state: Literal["correct", "present", "absent"]


class WordState(BaseModel):
    day: str
    guesses: list[list[Letter]]
    status: Literal["playing", "won", "lost"]
    maxGuesses: int
    answer: str | None
    points: int | None
    share: str | None


class QuestionIn(BaseModel):
    text: Text200
    options: list[Title80] = Field(min_length=4, max_length=4)
    correctIndex: int = Field(ge=0, le=3)


class QuestionPatch(BaseModel):
    text: Text200 | None = None
    options: list[Title80] | None = Field(default=None, min_length=4, max_length=4)
    correctIndex: int | None = Field(default=None, ge=0, le=3)


class QuizIn(BaseModel):
    title: Title80
    timeLimitS: int = Field(default=20, ge=5, le=120)


class QuizPatch(BaseModel):
    title: Title80 | None = None
    timeLimitS: int | None = Field(default=None, ge=5, le=120)
    status: Literal["draft", "archived"] | None = None


class StarterIn(BaseModel):
    pack: Literal["general", "science", "geography"] = "general"


class AnswerIn(BaseModel):
    questionId: str = Field(max_length=26)
    choice: int | None = Field(default=None, ge=0, le=3)


class PredictionIn(BaseModel):
    question: Text200
    options: list[Title80] = Field(min_length=2, max_length=6)
    closesAt: datetime
    points: int = Field(default=10, ge=1, le=100)


class VoteIn(BaseModel):
    optionId: str = Field(max_length=26)
