import asyncio
import socket
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException

from app.linkpreview import service


@pytest.fixture
def network(monkeypatch):
    requests = []
    dns_calls = []
    addresses = {"private.example": ["10.1.2.3"], "localhost": ["127.0.0.1"],
                 "mixed.example": ["93.184.216.34", "127.0.0.1"]}

    def dns(host, port, **kwargs):
        dns_calls.append(host)
        if host in addresses:
            values = addresses[host]
        else:
            try:
                values = [socket.inet_ntoa(socket.inet_aton(host))]
            except OSError:
                values = [host] if ":" in host else ["93.184.216.34"]
        return [(socket.AF_INET6 if ":" in value else socket.AF_INET,
                 socket.SOCK_STREAM, 6, "", (value, port)) for value in values]

    handler = {"response": lambda request: httpx.Response(200, headers={"Content-Type": "text/html"},
                                                         content=b'<title>Hello</title>')}

    async def transport(request):
        requests.append(request)
        return handler["response"](request)

    client_type = httpx.AsyncClient
    monkeypatch.setattr(service.socket, "getaddrinfo", dns)
    monkeypatch.setattr(service.httpx, "AsyncClient", lambda **kwargs: client_type(
        transport=httpx.MockTransport(transport), **kwargs))
    return requests, dns_calls, handler


@pytest.mark.parametrize("url", [
    'http://127.0.0.1/', 'http://10.0.1.2/', 'http://192.168.1.1/', 'http://172.16.0.1/',
    'http://169.254.169.254/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://0.0.0.0/', 'http://224.0.0.1/', 'http://240.0.0.1/', 'http://[ff02::1]/',
    'http://[fe80::1]/', 'http://[fec0::1]/', 'http://localhost/', 'http://private.example/', 'http://mixed.example/',
    'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
    'file:///etc/passwd', 'ftp://example.com/', 'http://user:pass@example.com/',
    'http://example.com:8080/', 'http://[fe80::1%25eth0]/',
])
async def test_unsafe_urls_never_connect(url, network):
    requests, _, _ = network
    with pytest.raises(ValueError):
        await service.fetch_preview(url)
    assert requests == []


async def test_redirect_revalidates_and_pins(network):
    requests, dns, handler = network
    handler['response'] = lambda request: httpx.Response(302, headers={
        'location': 'http://private.example/secret'})
    with pytest.raises(ValueError):
        await service.fetch_preview('https://public.example/')
    assert dns == ['public.example', 'private.example']
    assert len(requests) == 1
    assert requests[0].url.host == '93.184.216.34'
    assert requests[0].headers['host'] == 'public.example'
    assert requests[0].extensions['sni_hostname'] == 'public.example'


async def test_redirect_limit(network):
    requests, _, handler = network
    handler['response'] = lambda request: httpx.Response(302, headers={'location': '/again'})
    with pytest.raises(ValueError, match='redirect'):
        await service.fetch_preview('https://public.example/')
    assert len(requests) == 4


async def test_html_only_and_timeout(network):
    _, _, handler = network
    handler['response'] = lambda request: httpx.Response(200, headers={'content-type': 'image/png'})
    with pytest.raises(ValueError, match='HTML'):
        await service.fetch_preview('https://public.example/')
    def timeout(request):
        raise httpx.ReadTimeout('timed out')
    handler['response'] = timeout
    with pytest.raises(httpx.ReadTimeout):
        await service.fetch_preview('https://public.example/')


async def test_total_timeout_includes_dns(network, monkeypatch):
    monkeypatch.setattr(service, 'FETCH_TIMEOUT', 0.01)
    def slow_dns(*args, **kwargs):
        import time
        time.sleep(0.05)
        return []
    monkeypatch.setattr(service.socket, 'getaddrinfo', slow_dns)
    with pytest.raises(TimeoutError):
        await service.fetch_preview('https://public.example/')
    await asyncio.sleep(0.06)

class LargeBody(httpx.AsyncByteStream):
    def __init__(self):
        self.sent = 0
        self.closed = False

    async def __aiter__(self):
        for _ in range(1000):
            self.sent += 16384
            yield b'x' * 16384

    async def aclose(self):
        self.closed = True


async def test_stream_stops_at_limit(network):
    _, _, handler = network
    body = LargeBody()
    handler['response'] = lambda request: httpx.Response(200, headers={'content-type': 'text/html'},
                                                        stream=body)
    with pytest.raises(ValueError, match='large'):
        await service.fetch_preview('https://public.example/')
    assert body.sent <= service.MAX_BYTES + 16384
    assert body.closed


async def test_parse_and_cache(network, monkeypatch):
    requests, _, handler = network
    handler['response'] = lambda request: httpx.Response(200, headers={'content-type': 'text/html; charset=utf-8'}, content=b'''
        <title>Fallback</title><meta property="og:title" content=" A &amp; B ">
        <meta name="twitter:description" content="A description">
        <meta property="og:site_name" content="Example"><meta property="og:image" content="/image.jpg">
        ''')
    values = {}
    cache = AsyncMock()
    cache.get.side_effect = lambda key: values.get(key)
    async def save(key, value, ex):
        values[key] = value
        assert ex == 3600
    cache.set.side_effect = save
    monkeypatch.setattr(service, 'redis', cache)
    first = await service.preview('https://public.example/')
    second = await service.preview('https://public.example/')
    assert first == second
    assert first.title == 'A & B' and first.description == 'A description'
    assert first.siteName == 'Example' and first.image == 'https://public.example/image.jpg'
    assert len(requests) == 1


async def test_failure_cache(network, monkeypatch):
    cache = AsyncMock()
    cache.get.side_effect = [None, 'null']
    monkeypatch.setattr(service, 'redis', cache)
    with pytest.raises(HTTPException):
        await service.preview('http://127.0.0.1/')
    cache.set.assert_awaited_once()
    assert cache.set.call_args.kwargs['ex'] == 300
    with pytest.raises(HTTPException):
        await service.preview('http://127.0.0.1/')


def test_metadata_limits_and_unsafe_image():
    result = service.parse_html((
        '<meta property="og:title" content="' + 't' * 500 + '">'
        '<meta property="og:description" content="' + 'd' * 2000 + '">'
        '<meta property="og:site_name" content="' + 's' * 200 + '">'
        '<meta property="og:image" content="javascript:alert(1)">'
    ).encode(), 'https://example.com/')
    assert len(result.title) == 300
    assert len(result.description) == 1000
    assert len(result.siteName) == 100
    assert result.image is None


async def test_endpoint_auth_and_user_rate_limit(client, setup_chat, monkeypatch):
    from app.linkpreview import router
    assert (await client.get('/api/link-preview?url=https://example.com')).status_code == 401
    counter = AsyncMock()
    counter.eval.return_value = 31
    monkeypatch.setattr(router, 'redis', counter)
    response = await client.get('/api/link-preview?url=https://example.com', headers=setup_chat[3])
    assert response.status_code == 429
    assert counter.eval.call_args.args[-1] == f"rl:linkpreview:{setup_chat[0]['user']['id']}"
    counter.eval.return_value = 1
    monkeypatch.setattr(router, 'preview', AsyncMock(return_value=service.Preview(
        url='https://example.com/', host='example.com', title='Example')))
    response = await client.get('/api/link-preview?url=https://example.com', headers=setup_chat[3])
    assert response.status_code == 200 and response.json()['title'] == 'Example'
    assert (await client.get('/api/link-preview', headers=setup_chat[3])).status_code == 422
