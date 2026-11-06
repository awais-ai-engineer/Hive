import asyncio
import hashlib
import ipaddress
import json
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from fastapi import HTTPException

from app.db.session import redis
from app.linkpreview.schemas import Preview

MAX_BYTES = 1024 * 1024
FETCH_TIMEOUT = 3


def public_address(value: str) -> bool:
    address = ipaddress.ip_address(value)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if isinstance(address, ipaddress.IPv6Address) and address.is_site_local:
        return False
    return address.is_global and not any((address.is_private, address.is_loopback,
        address.is_link_local, address.is_multicast, address.is_reserved, address.is_unspecified))


def normalize_url(url: str) -> str:
    if len(url) > 4096 or any(ord(char) < 33 or ord(char) == 127 for char in url):
        raise ValueError("Invalid URL")
    parts = urlsplit(url)
    if (parts.scheme.lower() not in ("http", "https") or not parts.hostname
            or parts.username is not None or parts.password is not None
            or parts.port not in (None, 80, 443) or "%" in parts.hostname
            or parts.hostname.lower().rstrip(".") == "localhost"
            or parts.hostname.lower().rstrip(".").endswith(".localhost")
            or "\\" in parts.netloc):
        raise ValueError("Only public HTTP and HTTPS URLs on ports 80 and 443 are allowed")
    host = parts.hostname.lower().rstrip(".")
    components = host.split(".")
    if all(component.isdecimal() or component.startswith("0x") for component in components):
        # Reject legacy integer, hexadecimal and octal spellings before system DNS normalization.
        try:
            ipaddress.IPv4Address(host)
        except ipaddress.AddressValueError:
            raise ValueError("Use a canonical IP address") from None
    return urlunsplit((parts.scheme.lower(), parts.netloc, parts.path or "/", parts.query, ""))


async def resolve(url: str) -> tuple[str, str, str]:
    url = normalize_url(url)
    parts = urlsplit(url)
    host = parts.hostname.encode("idna").decode("ascii")
    records = await asyncio.to_thread(socket.getaddrinfo, host, parts.port or (
        443 if parts.scheme == "https" else 80), type=socket.SOCK_STREAM)
    addresses = [record[4][0] for record in records]
    if not addresses or not all(public_address(address) for address in addresses):
        raise ValueError("URL must resolve only to public addresses")
    address = addresses[0]
    netloc = f"[{address}]" if ":" in address else address
    if parts.port:
        netloc += f":{parts.port}"
    pinned = urlunsplit((parts.scheme, netloc, parts.path, parts.query, ""))
    authority = f"[{host}]" if ":" in host else host
    if parts.port:
        authority += f":{parts.port}"
    return pinned, authority, host


def clean(value: str, maximum: int) -> str:
    return " ".join(value.split())[:maximum]


class MetadataParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.fields = {}
        self.in_title = False
        self.title = ""

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "meta":
            name = (values.get("property") or values.get("name") or "").lower()
            if name in ("og:title", "og:description", "og:image", "og:site_name",
                        "twitter:title", "twitter:description", "twitter:image", "twitter:site",
                        "description"):
                self.fields.setdefault(name, clean(values.get("content") or "", 4096))

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title = (self.title + data)[:300]


def parse_html(data: bytes, url: str) -> Preview:
    parser = MetadataParser()
    parser.feed(data.decode("utf-8", errors="replace"))
    fields = parser.fields
    image = fields.get("og:image") or fields.get("twitter:image")
    if image:
        try:
            image = normalize_url(urljoin(url, image))
        except ValueError:
            image = None
    return Preview(url=url, host=urlsplit(url).hostname,
                   title=clean(fields.get("og:title") or fields.get("twitter:title") or parser.title, 300),
                   description=clean(fields.get("og:description") or fields.get("twitter:description")
                                     or fields.get("description", ""), 1000),
                   image=image, siteName=clean(fields.get("og:site_name")
                                              or fields.get("twitter:site", ""), 100))


async def fetch_preview(url: str) -> Preview:
    # The IP URL pins the connection; Host and SNI retain virtual hosting and TLS verification.
    async with asyncio.timeout(FETCH_TIMEOUT):
        async with httpx.AsyncClient(trust_env=False, follow_redirects=False,
                                     timeout=FETCH_TIMEOUT,
                                     limits=httpx.Limits(max_keepalive_connections=0)) as client:
            for hop in range(4):
                pinned, authority, hostname = await resolve(url)
                async with client.stream("GET", pinned, headers={"Host": authority,
                                         "Accept": "text/html", "Accept-Encoding": "identity"},
                                         extensions={"sni_hostname": hostname}) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        if hop == 3 or "location" not in response.headers:
                            raise ValueError("Too many redirects")
                        url = normalize_url(urljoin(url, response.headers["location"]))
                        continue
                    response.raise_for_status()
                    if response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "text/html":
                        raise ValueError("Page is not HTML")
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise ValueError("Compressed pages are not supported")
                    body = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=16384):
                        if len(body) + len(chunk) > MAX_BYTES:
                            raise ValueError("Page is too large")
                        body.extend(chunk)
                    return parse_html(bytes(body), url)
    raise ValueError("No page returned")


async def preview(url: str) -> Preview:
    try:
        url = normalize_url(url)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    key = "linkpreview:" + hashlib.sha256(url.encode()).hexdigest()
    cached = await redis.get(key)
    if cached is not None:
        value = json.loads(cached)
        if value is None:
            raise HTTPException(422, "Preview unavailable for this URL")
        return Preview.model_validate(value)
    try:
        result = await fetch_preview(url)
    except (ValueError, OSError, TimeoutError, httpx.HTTPError):
        await redis.set(key, "null", ex=300)
        raise HTTPException(422, "Preview unavailable for this URL") from None
    await redis.set(key, result.model_dump_json(), ex=3600)
    return result
