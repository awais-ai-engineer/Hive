import logging
from contextlib import asynccontextmanager

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import scheduler
from app.api import health
from app.auth.router import router as auth_router
from app.channels.router import router as channels_router
from app.comments.router import router as comments_router
from app.composer.router import router as composer_router
from app.core.config import settings
from app.db.session import engine, redis
from app.dms.router import router as dms_router
from app.explore.router import router as explore_router
from app.invites.router import router as invites_router
from app.linkpreview.router import router as linkpreview_router
from app.messages.router import router as messages_router
from app.posts.router import router as posts_router
from app.realtime.socket import sio
from app.reports.router import router as reports_router
from app.spaces.router import router as spaces_router
from app.storage.base import StorageError
from app.uploads.router import router as uploads_router
from app.users.router import router as users_router

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.validate_storage()
    scheduler.start()
    try:
        yield
    finally:
        await scheduler.stop()
    await engine.dispose()
    await redis.aclose()


api = FastAPI(title="Hive API", version="0.1.0", lifespan=lifespan)
api.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
api.include_router(health.router, prefix="/api")
api.include_router(auth_router, prefix="/api")
# Before users: /users/search must win over /users/{username}.
api.include_router(dms_router, prefix="/api")
api.include_router(users_router, prefix="/api")
api.include_router(spaces_router, prefix="/api")
api.include_router(explore_router, prefix="/api")
api.include_router(channels_router, prefix="/api")
api.include_router(invites_router, prefix="/api")
api.include_router(messages_router, prefix="/api")
api.include_router(uploads_router, prefix="/api")
api.include_router(posts_router, prefix="/api")
api.include_router(comments_router, prefix="/api")
api.include_router(reports_router, prefix="/api")
api.include_router(composer_router, prefix="/api")
api.include_router(linkpreview_router, prefix="/api")

# One ASGI app: Socket.IO handles /socket.io, everything else goes to FastAPI.
app = socketio.ASGIApp(sio, other_asgi_app=api)


@api.exception_handler(StorageError)
async def storage_error_handler(request, error):
    return JSONResponse(status_code=502, content={"detail": "Storage unavailable"})
