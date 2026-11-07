"""Anthropic Messages API over httpx (no SDK)."""

import asyncio
import logging

import httpx

from app.ai.provider import AIError, AIMessage, AIResult

log = logging.getLogger("hive.ai")
API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
RETRY_STATUSES = {429, 500, 502, 503, 504, 529}


class AnthropicProvider:
    def __init__(
        self, api_key: str, model: str, *, transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0, backoff: float = 1.0,
    ):
        self.api_key = api_key
        self.model = model
        self.transport = transport
        self.timeout = timeout
        self.backoff = backoff

    async def complete(
        self, *, system: str, messages: list[AIMessage], max_tokens: int, temperature: float | None = None
    ) -> AIResult:
        body: dict = {
            "model": self.model, "max_tokens": max_tokens, "system": system,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
        }
        if temperature is not None:  # some models only accept their default
            body["temperature"] = temperature
        headers = {"x-api-key": self.api_key, "anthropic-version": API_VERSION,
                   "content-type": "application/json"}
        response = None
        async with httpx.AsyncClient(transport=self.transport, timeout=self.timeout) as client:
            for attempt in (1, 2):
                try:
                    response = await client.post(API_URL, headers=headers, json=body)
                except httpx.TimeoutException:
                    error = AIError("ai_timeout", "The AI service took too long to answer. Please try again.")
                except httpx.HTTPError:
                    error = AIError("ai_unreachable", "The AI service could not be reached. Please try again.")
                else:
                    if response.status_code not in RETRY_STATUSES:
                        break
                    error = None
                if attempt == 1:
                    await asyncio.sleep(self.backoff)
                elif error is not None:
                    raise error
        return self._parse(response)

    def _parse(self, response: httpx.Response) -> AIResult:
        status = response.status_code
        if status in (401, 403):
            log.warning("AI provider rejected the API key (status %s)", status)
            raise AIError("ai_auth", "The AI service rejected this server's credentials.")
        if status in (429, 529):
            raise AIError("ai_busy", "The AI service is busy right now. Please try again in a moment.")
        if status >= 500:
            raise AIError("ai_unavailable", "The AI service is having problems. Please try again later.")
        if status >= 400:
            log.warning("AI provider refused the request (status %s)", status)
            raise AIError("ai_rejected", "The AI service could not handle this request.")
        data = response.json()
        if data.get("stop_reason") == "refusal":
            raise AIError("ai_refused", "The AI service declined to answer this.")
        text = "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text")
        usage = data.get("usage", {})
        return AIResult(
            text=text.strip(), input_tokens=int(usage.get("input_tokens", 0)),
            output_tokens=int(usage.get("output_tokens", 0)), model=data.get("model", self.model),
        )
