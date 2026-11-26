"""Optional operator-owned CPU speech worker; never deploys automatically with the API."""
import asyncio
import hmac
import io
import os
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

model = None


@asynccontextmanager
async def lifespan(app):
    global model
    from faster_whisper import WhisperModel
    if not os.environ.get('TRANSCRIPTION_TOKEN'):
        raise RuntimeError('Configure a private TRANSCRIPTION_TOKEN before starting the speech worker')
    model = await asyncio.to_thread(WhisperModel, os.environ.get('WHISPER_MODEL', 'small'), device='cpu', compute_type='int8')
    yield
    model = None


app = FastAPI(docs_url=None, redoc_url=None, lifespan=lifespan)
slots = asyncio.Semaphore(1)


@app.get('/health')
async def health():
    if model is None:
        raise HTTPException(503, 'Speech model is not ready')
    return {'status': 'ready'}


def recognize(audio, language):
    if model is None:
        raise RuntimeError('Speech model is not ready')
    segments, _ = model.transcribe(io.BytesIO(audio), language=None if language == 'auto' else language.split('-')[0],
        word_timestamps=True, vad_filter=True, condition_on_previous_text=False, beam_size=5)
    return {'words': [{'start': word.start, 'end': word.end, 'word': word.word}
                      for segment in segments for word in (segment.words or [])]}


@app.post('/transcribe')
async def transcribe(audio: Annotated[UploadFile, File()], authorization: str = Header(default=''),
                     language: str = Form(default='auto')):
    token = os.environ.get('TRANSCRIPTION_TOKEN', '')
    if not token or not hmac.compare_digest(authorization, f'Bearer {token}'):
        raise HTTPException(401, 'Unauthorized')
    if language not in ('en-US', 'ur-PK', 'auto'):
        raise HTTPException(422, 'Unsupported language')
    data = await audio.read(512001)
    if len(data) > 512000:
        raise HTTPException(413, 'Speech window too large')
    try:
        await asyncio.wait_for(slots.acquire(), timeout=.2)
    except TimeoutError:
        raise HTTPException(429, 'Speech worker is busy; retry the same window') from None
    try:
        try:
            return await asyncio.to_thread(recognize, data, language)
        except (RuntimeError, ValueError, OSError):
            # No meeting content, request body or credential is included in errors/logs.
            raise HTTPException(503, 'Speech inference unavailable') from None
    finally:
        slots.release()
