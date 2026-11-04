from functools import lru_cache

from app.core.config import settings
from app.storage.base import Storage
from app.storage.local import LocalStorage
from app.storage.supabase import SupabaseStorage


@lru_cache
def get_storage() -> Storage:
    settings.validate_storage()
    return SupabaseStorage() if settings.storage_driver == "supabase" else LocalStorage()
