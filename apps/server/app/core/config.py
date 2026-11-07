from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    port: int = 4000
    web_origin: str = "http://localhost:3000"
    database_url: str = "postgresql+asyncpg://hive:hive@localhost:5434/hive"
    redis_url: str = "redis://localhost:6380"
    socketio_channel: str = "hive-socketio"
    moderation_url: str = "http://localhost:8000"
    jwt_secret: str = "dev-change-me"
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    cookie_secure: bool = False
    # WebRTC ICE servers as JSON. Add a TURN server here when deploying behind strict NATs.
    ice_servers: str = '[{"urls": "stun:stun.l.google.com:19302"}]'
    upload_dir: str = "uploads"
    storage_driver: str = "local"
    max_image_mb: int = 10
    max_video_mb: int = 100
    max_audio_mb: int = 10
    max_file_mb: int = 10
    supabase_url: str = ""
    supabase_service_key: str = ""
    supabase_bucket: str = "hive-media"
    signed_url_seconds: int = 3600
    # Seeds the daily word so answers can't be worked out from the word list alone.
    game_secret: str = "dev-game-secret"
    # AI features: "disabled" or "anthropic". Everything AI stays off until a key is set.
    ai_provider: str = "disabled"
    anthropic_api_key: str = ""
    ai_model: str = "claude-sonnet-5-5"
    ai_rate_limit_per_hour: int = 60
    ai_max_input_chars: int = 24000
    ai_max_output_tokens: int = 2000

    # Browser push (Web Push with VAPID). Leave empty to switch push off; generate a pair with
    # `python -m app.push.keys`.
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:admin@example.com"

    def validate_storage(self):
        if self.storage_driver not in ("local", "supabase"):
            raise ValueError("STORAGE_DRIVER must be local or supabase")
        if self.storage_driver == "supabase" and not all((self.supabase_url, self.supabase_service_key, self.supabase_bucket)):
            raise ValueError("Supabase storage requires SUPABASE_URL, SUPABASE_SERVICE_KEY and SUPABASE_BUCKET")


settings = Settings()
