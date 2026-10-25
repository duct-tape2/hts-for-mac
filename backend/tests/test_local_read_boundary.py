from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import analysis_routes, main


def _analysis_registry(calls: list[tuple[str, dict]]) -> dict:
    def get_feature(feature_id: str, params: dict, *, instrument: object) -> dict:
        calls.append((feature_id, params))
        return {"featureId": feature_id, "status": "snapshot", "rows": [], "complete": True}

    return {
        "audit-read": (
            SimpleNamespace(get_feature=get_feature),
            {"title": "audit", "market": "KR", "description": "audit", "parameters": []},
        )
    }


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "https://evil.example"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate"},
    ],
)
def test_cross_site_analysis_is_rejected_before_adapter(monkeypatch, headers):
    calls: list[tuple[str, dict]] = []
    monkeypatch.setattr(analysis_routes, "_registry", lambda: _analysis_registry(calls))
    monkeypatch.setattr(analysis_routes, "_cache", {})

    with TestClient(main.app, base_url="http://localhost") as client:
        response = client.get("/api/analysis/audit-read", headers=headers)

    assert response.status_code == 403
    assert response.json() == {"detail": "local API request required"}
    assert calls == []


def test_nonlocal_host_is_rejected_before_quote_adapter(monkeypatch):
    called = False

    def quote(**_kwargs):
        nonlocal called
        called = True
        raise AssertionError("quote adapter must not run")

    monkeypatch.setattr(main.kiwoom_gateway, "get_quote", quote)
    with TestClient(main.app, base_url="http://evil.example") as client:
        response = client.get("/api/quotes?market=US&stk_cd=NVDA&stex_tp=ND&listing_venue=NASDAQ")

    assert response.status_code == 403
    assert called is False


def test_loopback_ui_and_headerless_cli_reads_remain_allowed(monkeypatch):
    calls: list[str] = []

    def quote(**_kwargs):
        calls.append("quote")
        return {"market": "US", "stkCd": "NVDA"}

    monkeypatch.setattr(main.kiwoom_gateway, "get_quote", quote)
    path = "/api/quotes?market=US&stk_cd=NVDA&stex_tp=ND&listing_venue=NASDAQ"
    with TestClient(main.app, base_url="http://localhost") as client:
        ui = client.get(path, headers={"Origin": "http://127.0.0.1:3010", "Sec-Fetch-Site": "same-site"})
        cli = client.get(path)

    assert ui.status_code == cli.status_code == 200
    assert calls == ["quote", "quote"]
