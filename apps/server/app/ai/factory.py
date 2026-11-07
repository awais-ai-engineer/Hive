from app.ai.anthropic import AnthropicProvider
from app.ai.provider import AIProvider
from app.core.config import settings


def get_provider() -> AIProvider | None:
    """The configured provider, or None while AI is switched off. Read at call time."""
    if settings.ai_provider == "anthropic" and settings.anthropic_api_key:
        return AnthropicProvider(settings.anthropic_api_key, settings.ai_model)
    return None
