from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol


class StorageError(Exception):
    """The object storage service is unavailable."""


@dataclass(frozen=True)
class StoredObject:
    key: str
    content_type: str


@dataclass(frozen=True)
class SignRequest:
    key: str
    filename: str
    inline: bool
    # Seconds the link stays valid; None uses the normal signed-link lifetime.
    ttl: int | None = None


class Storage(Protocol):
    async def save(self, key: str, chunks: AsyncIterator[bytes], content_type: str) -> None: ...
    async def delete(self, keys: list[str]) -> None: ...
    async def signed_urls(self, items: list[SignRequest]) -> dict[str, str]: ...
