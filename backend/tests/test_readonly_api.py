from __future__ import annotations

import json
import os
import socket
import subprocess
import sys

from fastapi.testclient import TestClient

from app import main
from app.main import app
from app.store import AppStore


def _deny_socket(*_args, **_kwargs):
    raise AssertionError("test attempted outbound socket I/O")


def test_fixture_market_surface_is_serializable_and_never_uses_socket(monkeypatch):
    monkeypatch.setattr(socket.socket, "connect", _deny_socket)
    with TestClient(app) as client:
        kr = client.get("/api/quotes", params={"market": "KR", "stk_cd": "005930"})
        us = client.get("/api/quotes", params={"market": "US", "stk_cd": "BRK.B", "stex_tp": "NY", "listing_venue": "NYSE"})
        chart = client.get("/api/charts", params={"market": "KR", "stk_cd": "005930", "interval": "D"})
        search = client.get("/api/symbols/search", params={"market": "KR", "q": "삼성"})
    assert kr.status_code == us.status_code == chart.status_code == search.status_code == 200
    for response in (kr, us, chart, search):
        json.dumps(response.json(), allow_nan=False)
    assert kr.json()["stkCd"] == "005930"
    assert kr.json()["environment"] == "fixture"
    assert len(kr.json()["asks"]) == len(kr.json()["bids"]) == 10
    assert us.json()["stkCd"] == "BRK.B"
    assert len(us.json()["asks"]) == len(us.json()["bids"]) == 10
    assert chart.json()["bars"] and chart.json()["complete"] is True
    assert search.json()["results"][0]["listingVenue"] == "KOSPI"


def test_orders_account_history_and_trading_controls_are_not_registered(monkeypatch):
    monkeypatch.setenv("KIWOOM_ORDERS_ENABLED", "true")
    calls = 0

    def count_connect(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise AssertionError("outbound call")

    monkeypatch.setattr(socket.socket, "connect", count_connect)
    with TestClient(app) as client:
        for path in ("/api/orders", "/api/orders/x/cancel", "/api/account/deposit", "/api/account/positions", "/api/trades", "/api/system/kill"):
            assert client.post(path).status_code in {404, 405}
        schema = client.get("/openapi.json").json()["paths"]
    assert not any("order" in path or "account" in path or "trade" in path or "/api/system" in path for path in schema)
    assert calls == 0


def test_local_watchlists_persist_and_import_is_explicit(monkeypatch):
    monkeypatch.setattr(socket.socket, "connect", _deny_socket)
    with TestClient(app) as client:
        created = client.post("/api/watchlists", json={"name": "mixed"})
        assert created.status_code == 200
        group = next(row for row in created.json()["watchlists"] if row["name"] == "mixed")
        for item in (
            {"market": "KR", "stkCd": "005930", "stkNm": "삼성전자", "listingVenue": "KOSPI"},
            {"market": "US", "stkCd": "BRK.B", "stkNm": "Berkshire", "stexTp": "NY", "listingVenue": "NYSE"},
        ):
            assert client.post(f"/api/watchlists/{group['id']}/items", json=item).status_code == 200
        imported = client.post(f"/api/watchlists/{group['id']}/import-kiwoom")
        assert imported.status_code == 200
        state = client.get("/api/state").json()
        assert any(row["id"] == group["id"] for row in state["watchlists"])
        assert any(row["source"] == "kiwoom_import" for row in state["watchlists"])
        assert client.delete(f"/api/watchlists/{group['id']}").status_code == 200

    # The test process did not load dotenv and only wrote its isolated v2 file.
    assert "dotenv" not in os.sys.modules


def test_watchlist_mutation_rejects_foreign_origin():
    with TestClient(app) as client:
        response = client.post("/api/watchlists", json={"name": "blocked"}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403


def test_legacy_order_flag_at_startup_cannot_restore_routes_or_socket_io(tmp_path):
    code = """
import socket
socket.socket.connect = lambda *_a, **_k: (_ for _ in ()).throw(AssertionError('socket'))
from fastapi.testclient import TestClient
from app.main import app
with TestClient(app) as client:
    assert client.post('/api/orders').status_code in (404, 405)
    assert not any('/api/orders' in path for path in client.get('/openapi.json').json()['paths'])
"""
    environment = dict(os.environ, KIWOOM_ENABLED="true", KIWOOM_MODE="real", KIWOOM_ORDERS_ENABLED="true", READONLY_DATA_DIR=str(tmp_path))
    result = subprocess.run([sys.executable, "-c", code], env=environment, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_passive_quote_does_not_create_realtime_subscription(monkeypatch):
    quote = {"market": "US", "stkCd": "BRK.B", "stexTp": "NY", "listingVenue": "NYSE", "quoteVenue": "NY", "environment": "real"}
    selected = []
    monkeypatch.setattr(main, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(main.kiwoom_gateway, "get_quote", lambda **_kwargs: dict(quote))
    monkeypatch.setattr(main.market_stream, "snapshot", lambda _identity: None)
    monkeypatch.setattr(main.market_stream, "subscribe", lambda value: selected.append(value))
    main._quote(stk_cd="BRK.B", stex_tp="NY", market="US", listing_venue="NYSE", book=False)
    assert selected == []


def test_watchlist_api_ignores_forged_item_environment():
    with TestClient(app) as client:
        group = client.post("/api/watchlists", json={"name": "forged-env"}).json()["watchlists"][-1]
        item = {"market": "US", "stkCd": "BRK.B", "stkNm": "Berkshire", "stexTp": "NY", "listingVenue": "NYSE"}
        assert client.post(f"/api/watchlists/{group['id']}/items", json={**item, "environment": "real"}).status_code == 200
        response = client.post(f"/api/watchlists/{group['id']}/items", json={**item, "environment": "demo"})
        assert response.status_code == 200
        rows = [row for row in response.json()["items"] if row["watchlistId"] == group["id"]]
        assert len(rows) == 1 and rows[0]["environment"] == "fixture"


def test_portable_watchlist_endpoint_is_bounded_strict_and_local_only(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "store", AppStore(tmp_path / "watchlist-v2.json"))
    item = {"market": "US", "stkCd": "AAPL", "stkNm": "Apple", "stexTp": "ND", "listingVenue": "NASDAQ", "quoteVenue": "ND", "currency": "USD"}
    with TestClient(app) as client:
        saved = client.post("/api/watchlists/import-local", json={"version": 1, "watchlists": [{"name": "전송 그룹", "instruments": [item]}]})
        assert saved.status_code == 200
        row = next(value for value in saved.json()["items"] if value["stkCd"] == "AAPL")
        assert row["environment"] == "fixture"
        assert all(row[key] is None for key in ("last", "prevClose", "open", "changePct"))

        malicious = client.post("/api/watchlists/import-local", json={"version": 1, "watchlists": [], "apiKey": "must-not-parse"})
        assert malicious.status_code == 400
        forged_environment = client.post("/api/watchlists/import-local", json={"version": 1, "watchlists": [{"name": "bad", "instruments": [{**item, "environment": "real"}]}]})
        assert forged_environment.status_code == 400
        oversized = client.post("/api/watchlists/import-local", content=b"x" * 1_048_577, headers={"Content-Type": "application/json"})
        assert oversized.status_code == 413
