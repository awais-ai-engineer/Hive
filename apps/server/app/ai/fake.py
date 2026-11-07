"""A scripted provider for tests: records every prompt it receives."""

from collections.abc import Callable

from app.ai.provider import AIMessage, AIResult


class FakeProvider:
    def __init__(self, responses: list[str] | Callable[[str, str], str] | None = None):
        self.responses = responses if responses is not None else (lambda system, prompt: "ok")
        self.calls: list[dict] = []

    async def complete(
        self, *, system: str, messages: list[AIMessage], max_tokens: int, temperature: float | None = None
    ) -> AIResult:
        prompt = "\n".join(m.content for m in messages)
        self.calls.append({"system": system, "prompt": prompt, "max_tokens": max_tokens})
        if callable(self.responses):
            text = self.responses(system, prompt)
        else:
            text = self.responses[min(len(self.calls), len(self.responses)) - 1]
        return AIResult(text=text, input_tokens=len(prompt) // 4 + 1, output_tokens=len(text) // 4 + 1,
                        model="fake-model")

    @property
    def prompts(self) -> str:
        return "\n".join(call["prompt"] for call in self.calls)
