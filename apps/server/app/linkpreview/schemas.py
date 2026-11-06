from pydantic import BaseModel


class Preview(BaseModel):
    url: str
    host: str
    title: str = ""
    description: str = ""
    image: str | None = None
    siteName: str = ""
