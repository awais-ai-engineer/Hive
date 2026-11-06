from typing import Annotated

from pydantic import BaseModel, Field, StrictInt


class AudioMetadata(BaseModel):
    durationMs: Annotated[StrictInt, Field(ge=1, le=300000)]
    waveform: Annotated[list[Annotated[StrictInt, Field(ge=0, le=100)]],
                        Field(min_length=64, max_length=64)]
