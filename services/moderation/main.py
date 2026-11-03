"""Hive moderation service.

Stub scorer for now. Later: a Hugging Face toxicity model exported to ONNX.
"""
import re

from fastapi import FastAPI
from pydantic import BaseModel

MODEL_VERSION = "stub-0"
BANNED = {"idiot", "stupid", "hate"}
LINK_RE = re.compile(r"https?://", re.I)

app = FastAPI(title="Hive Moderation")


class ScoreRequest(BaseModel):
    text: str


class ScoreResponse(BaseModel):
    toxicity: float
    spam: float
    model_version: str


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model_version": MODEL_VERSION}


@app.post("/score", response_model=ScoreResponse)
def score(req: ScoreRequest) -> ScoreResponse:
    words = re.findall(r"[a-z']+", req.text.lower())
    bad = sum(w in BANNED for w in words)
    toxicity = min(1.0, bad / max(len(words), 1) * 5)
    spam = min(1.0, len(LINK_RE.findall(req.text)) * 0.3)
    return ScoreResponse(toxicity=round(toxicity, 3), spam=round(spam, 3), model_version=MODEL_VERSION)
