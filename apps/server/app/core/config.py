from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    port: int = 4000
    web_origin: str = "http://localhost:3000"
    database_url: str = "postgresql+asyncpg://hive:hive@localhost:5434/hive"
    redis_url: str = "redis://localhost:6380"
    moderation_url: str = "http://localhost:8000"
    jwt_secret: str = "dev-change-me"
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    cookie_secure: bool = False


settings = Settings()
