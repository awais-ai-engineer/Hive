import logging
from contextlib import asynccontextmanager

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import scheduler
from app.ai.router import me_router as ai_me_router
from app.ai.router import router as ai_router
from app.api import health
from app.apps.router import public_router as apps_public_router
from app.apps.router import router as apps_router
from app.auth.router import router as auth_router
from app.calls.router import router as calls_router
from app.channels.router import router as channels_router
from app.comments.router import router as comments_router
from app.composer.router import router as composer_router
from app.core.config import settings
from app.db.session import engine, redis
from app.directory.router import router as directory_router
from app.disappearing.router import router as disappearing_router
from app.dms.router import router as dms_router
from app.docs.router import router as docs_router
from app.explore.router import router as explore_router
from app.files.router import router as files_router
from app.games.router import hub_router as games_hub_router
from app.games.router import router as games_router
from app.invites.router import router as invites_router
from app.linkpreview.router import router as linkpreview_router
from app.messages.router import router as messages_router
from app.notifications.router import router as notifications_router
from app.posts.router import router as posts_router
from app.push import service as push_service
from app.push import vapid
from app.push.router import router as push_router
from app.realtime.socket import sio
from app.reports.router import router as reports_router
from app.saved.router import router as saved_router
from app.search.router import router as search_router
from app.secret.router import router as secret_router
from app.sidebar.router import router as sidebar_router
from app.spaces.router import router as spaces_router
from app.storage.base import StorageError
from app.tasks.router import router as tasks_router
from app.uploads.router import router as uploads_router
from app.users.router import router as users_router
from app.workflows.router import router as workflows_router

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.validate_storage()
    vapid.startup_notice()
    scheduler.start()
    try:
        yield
    finally:
        await scheduler.stop()
        await push_service.drain()
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
api.include_router(sidebar_router, prefix="/api")
api.include_router(directory_router, prefix="/api")
api.include_router(calls_router, prefix="/api")
api.include_router(docs_router, prefix="/api")
api.include_router(tasks_router, prefix="/api")
api.include_router(composer_router, prefix="/api")
api.include_router(linkpreview_router, prefix="/api")
api.include_router(games_hub_router, prefix="/api")
api.include_router(games_router, prefix="/api")
api.include_router(ai_router, prefix="/api")
api.include_router(ai_me_router, prefix="/api")
api.include_router(files_router, prefix="/api")
api.include_router(saved_router, prefix="/api")
api.include_router(notifications_router, prefix="/api")
api.include_router(search_router, prefix="/api")
api.include_router(apps_router, prefix="/api")
api.include_router(apps_public_router, prefix="/api")
api.include_router(workflows_router, prefix="/api")
api.include_router(disappearing_router, prefix="/api")
api.include_router(secret_router, prefix="/api")
api.include_router(push_router, prefix="/api")

# One ASGI app: Socket.IO handles /socket.io, everything else goes to FastAPI.
app = socketio.ASGIApp(sio, other_asgi_app=api)


@api.exception_handler(StorageError)
async def storage_error_handler(request, error):
    return JSONResponse(status_code=502, content={"detail": "Storage unavailable"})
