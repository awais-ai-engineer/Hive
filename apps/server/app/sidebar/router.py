from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_session
from app.realtime.socket import sio
from app.sidebar import service
from app.sidebar.schemas import (
    BuiltInSection,
    CollapsedIn,
    PrefIn,
    PrefOut,
    SectionIn,
    SectionOrderIn,
    SectionOut,
    SectionPatch,
    SidebarOut,
    StarOut,
)

router = APIRouter(prefix="/me", tags=["sidebar"])
Session = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


async def changed(user: User) -> None:
    """Tell the user's other tabs to reload their sidebar."""
    await sio.emit("sidebar:updated", {}, room=f"user:{user.id}")


@router.get("/stars", response_model=list[StarOut])
async def get_stars(user: CurrentUser, session: Session):
    return await service.list_stars(session, user)


@router.put("/stars/{channel_id}", response_model=StarOut)
async def put_star(channel_id: str, user: CurrentUser, session: Session):
    star = await service.add_star(session, user, channel_id)
    await changed(user)
    return star


@router.delete("/stars/{channel_id}", status_code=204)
async def delete_star(channel_id: str, user: CurrentUser, session: Session):
    await service.remove_star(session, user, channel_id)
    await changed(user)


@router.get("/conversation-prefs", response_model=list[PrefOut])
async def get_prefs(user: CurrentUser, session: Session):
    prefs = await service.list_prefs(session, user)
    return [PrefOut(channel_id=pref.channel_id, level=pref.level) for pref in prefs]


@router.put("/conversation-prefs/{channel_id}", response_model=PrefOut)
async def put_pref(channel_id: str, data: PrefIn, user: CurrentUser, session: Session):
    await service.set_pref(session, user, channel_id, data.level)
    await changed(user)
    return PrefOut(channel_id=channel_id, level=data.level)


@router.get("/sidebar", response_model=SidebarOut)
async def get_sidebar(user: CurrentUser, session: Session):
    return await service.get_sidebar(session, user)


@router.post("/sidebar/sections", response_model=SectionOut, status_code=201)
async def post_section(data: SectionIn, user: CurrentUser, session: Session):
    section = await service.create_section(session, user, data)
    await changed(user)
    return section


@router.put("/sidebar/sections/order", status_code=204)
async def put_section_order(data: SectionOrderIn, user: CurrentUser, session: Session):
    await service.order_sections(session, user, data.ids)
    await changed(user)


@router.patch("/sidebar/sections/{section_id}", status_code=204)
async def patch_section(section_id: str, data: SectionPatch, user: CurrentUser, session: Session):
    await service.update_section(session, user, section_id, data)
    await changed(user)


@router.delete("/sidebar/sections/{section_id}", status_code=204)
async def delete_section(section_id: str, user: CurrentUser, session: Session):
    await service.delete_section(session, user, section_id)
    await changed(user)


@router.put("/sidebar/sections/{section_id}/items/{channel_id}", status_code=204)
async def put_item(section_id: str, channel_id: str, user: CurrentUser, session: Session):
    await service.move_to_section(session, user, section_id, channel_id)
    await changed(user)


@router.delete("/sidebar/items/{channel_id}", status_code=204)
async def delete_item(channel_id: str, user: CurrentUser, session: Session):
    """Take a conversation out of its custom section, back to the default one."""
    await service.remove_from_sections(session, user, channel_id)
    await changed(user)


@router.put("/sidebar/collapsed/{key}", status_code=204)
async def put_collapsed(key: BuiltInSection, data: CollapsedIn, user: CurrentUser, session: Session):
    await service.set_collapsed(session, user, key, data.collapsed)
    await changed(user)
