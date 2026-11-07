from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class AIMessage:
    role: Literal["user", "assistant"]
    content: str


@dataclass(frozen=True)
class AIResult:
    text: str
    input_tokens: int
    output_tokens: int
    model: str


class AIError(Exception):
    """A failed model call, with a short code and a message safe to show to people."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class AIProvider(Protocol):
    async def complete(
        self, *, system: str, messages: list[AIMessage], max_tokens: int, temperature: float | None = None
    ) -> AIResult: ...
