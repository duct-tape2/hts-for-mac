from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json

from fastapi.testclient import TestClient
from app import main, kiwoom_gateway as gateway


def identity(code="005930"):
    return {**gateway._identity(market="KR", stk_cd=code, stex_tp="KRX", listing_venue="KOSPI"), "stkNm": code}


def test_book_only_never_replaces_trade_or_claims_live_trade():
    base = gateway._fixture_quote(identity(), book=True)
    now = datetime.now(timezone.utc).isoformat()
    stream = {**identity(), "receivedAt": now, "bookReceivedAt": now, "bookLive": True, "status": "live", "asks": [{"price": 80000, "qty": 0}], "bids": [{"price": 79900, "qty": None}]}
    merged = gateway.merge_stream(base, stream)
    assert merged["last"] == base["last"] and merged["status"] == "snapshot"
    assert merged["bookLive"] and merged["askQty"] == 0 and merged["midPrice"] == 79950
    stream.update(tradeReceivedAt=now, last=80010, change=-100, changePct=-0.1, volume=0)
    merged = gateway.merge_stream(base, stream)
    assert merged["last"] == 80010 and merged["status"] == "live" and merged["volume"] == 0
    assert gateway.merge_stream(base, {**stream, "stkCd": "000660"})["last"] == base["last"]


def test_stream_rejects_foreign_origin_and_runtime_identity():
    with TestClient(main.app) as client:
        body = {"instruments": [identity()]}
        assert client.post("/api/market/stream", json=body, headers={"Origin": "https://evil.example"}).status_code == 403
        body["instruments"][0]["environment"] = "real"
        assert client.post("/api/market/stream", json=body).status_code == 400
        assert client.post("/api/market/stream", json={"instruments": [identity()] * 201}).status_code == 422


def test_multiplex_generator_releases_each_reference_on_disconnect(monkeypatch):
    instruments = [identity(), identity("000660")]
    registered, released = [], []
    monkeypatch.setattr(main, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(main.market_stream, "subscribe", lambda item: registered.append(item["stkCd"]) or item["stkCd"])
    monkeypatch.setattr(main.market_stream, "unsubscribe", released.append)
    monkeypatch.setattr(main.market_stream, "snapshot", lambda item: None)
    monkeypatch.setattr(gateway, "get_quote", lambda **kwargs: gateway._fixture_quote(identity(kwargs["stk_cd"]), book=True))

    class Request:
        async def is_disconnected(self):
            return False

    async def exercise():
        stream = main._market_events(instruments, Request())
        seen = set()
        async for packet in stream:
            if "event: quote\n" in packet:
                seen.add(json.loads(packet.split("data: ", 1)[1])["stkCd"])
            if len(seen) == 2:
                break
        await stream.aclose()
        return seen

    assert asyncio.run(exercise()) == {"005930", "000660"}
    assert registered == released == ["005930", "000660"]


def test_sse_prevents_proxy_compression_buffering():
    response = main._stream_response([], object())
    assert 'no-transform' in response.headers['cache-control']
    assert response.headers['x-accel-buffering'] == 'no'


def test_stream_lease_releases_each_subscription_and_requests_rotation(monkeypatch):
    registered, released = [], []
    monkeypatch.setattr(main, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(main.market_stream, "subscribe", lambda item: registered.append(item["stkCd"]) or item["stkCd"])
    monkeypatch.setattr(main.market_stream, "unsubscribe", released.append)

    class Request:
        async def is_disconnected(self):
            return False

    async def exercise():
        stream = main._market_events([identity()], Request(), lease_seconds=0)
        assert await anext(stream) == ": connected\n\n"
        packet = await anext(stream)
        await stream.aclose()
        return packet

    packet = asyncio.run(exercise())
    assert "event: stream-retry" in packet and '"retryAfterMs": 1000' in packet
    assert registered == released == ["005930"]


def test_stream_lease_scales_for_large_multiplexed_initial_refreshes():
    assert main._stream_lease_seconds(2) == 32.4
    assert main._stream_lease_seconds(100) == 150.0
    assert main._stream_lease_seconds(200) == 270.0


def test_stream_cors_preflight_allows_the_loopback_ui_post():
    with TestClient(main.app) as client:
        response = client.options(
            "/api/market/stream",
            headers={
                "Origin": "http://127.0.0.1:3010",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:3010"
    assert "POST" in response.headers["access-control-allow-methods"]


def test_old_socket_book_never_overwrites_newer_rest_book():
    quote = gateway._fixture_quote(identity(), book=True)
    old = {**identity(), 'bookReceivedAt':'2020-01-01T00:00:00Z','bookLive':False,'asks':[{'price':1,'qty':2}],'bids':[],'status':'stale'}
    merged = gateway.merge_stream(quote, old)
    assert merged['asks'] == quote['asks']
    assert merged['bookReceivedAt'] == quote['bookReceivedAt']


def test_chart_cache_is_bounded_by_total_bars(monkeypatch):
    cache = {}
    monkeypatch.setattr(gateway, '_chart_cache', cache)
    gateway._remember(cache, ('old',), {'bars':[None]*80000}, 64)
    gateway._remember(cache, ('new',), {'bars':[None]*80000}, 64)
    assert list(cache) == [('new',)]


def test_capture_route_rejects_unknown_or_screen_unsupported_filters():
    with TestClient(main.app) as client:
        assert client.get("/api/hts/screens/0184?notAFilter=1").status_code == 422
        assert client.get("/api/hts/screens/0184?volumeBand=500k").status_code == 422
        assert client.get("/api/hts/screens/0162?direction=previousUpLimit&limitSort=streak").status_code == 200
