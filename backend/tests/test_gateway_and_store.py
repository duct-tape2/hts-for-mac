from __future__ import annotations

import importlib
import json
import os
from copy import deepcopy
from pathlib import Path

import pytest

from app import kiwoom_gateway as gateway
from app import book_hub
from app.store import AppStore

store_module = importlib.import_module("app.store")


class Response:
    def __init__(self, body, *, has_next=False, next_key=None):
        self.body = body
        self.continuation = type("Continuation", (), {"has_next": has_next, "cont_yn": "Y" if has_next else "N", "next_key": next_key})()


def test_kr_mapping_keeps_change_sign_and_nulls_zero_prices(monkeypatch):
    basic = Response({"stk_cd": "005930", "stk_nm": "삼성전자", "cur_prc": "-71500", "base_pric": "71000", "open_pric": "-0", "high_pric": "+72100", "low_pric": "0", "pred_pre": "-500", "flu_rt": "-0.70", "trde_qty": "0"})
    order_book = Response({"sel_fpr_bid": "-71510", "sel_fpr_req": "10", "buy_fpr_bid": "71490", "buy_fpr_req": "0"})

    def fake_fetch(api_id, *_args, **_kwargs):
        return basic if api_id == "ka10001" else order_book

    monkeypatch.setattr(gateway, "_fetch_page", fake_fetch)
    identity = gateway._identity(market="KR", stk_cd="005930", stex_tp="KRX", listing_venue="KOSPI")
    quote = gateway._kr_quote(identity, book=True)
    assert quote["last"] == 71500.0
    assert quote["change"] == -500.0 and quote["changePct"] == -0.70
    assert quote["open"] is None and quote["low"] is None
    assert quote["volume"] == 0.0
    assert quote["bidQty"] == 0.0
    assert quote["rawPrices"]["pred_pre"] == "-500"


def test_policy_rejects_overridden_sdk_host_before_client_or_socket(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "KIWOOM_MODE", "real")
    monkeypatch.setenv("PRD", "https://evil.example")
    called = False

    def no_client():
        nonlocal called
        called = True
        raise AssertionError("SDK client must not be constructed")

    monkeypatch.setattr(gateway, "_client", no_client)
    with pytest.raises(gateway.RequestDenied):
        gateway._fetch_page("ka10001", "/api/dostk/stkinfo", {"stk_cd": "005930"})
    assert called is False


def test_real_error_does_not_fall_back_to_fixture(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_args, **_kwargs: (_ for _ in ()).throw(gateway.BrokerError("failed")))
    with pytest.raises(gateway.BrokerError):
        gateway.get_quote(market="KR", stk_cd="005930", stex_tp="KRX", listing_venue="KOSPI")


def test_pagination_marks_repeated_cursor_incomplete(monkeypatch):
    responses = iter([Response({"list": [{"code": "005930"}]}, has_next=True, next_key="same"), Response({"list": [{"code": "000660"}]}, has_next=True, next_key="same")])
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_args, **_kwargs: next(responses))
    rows, complete, note = gateway._fetch_rows("ka10099", "/api/dostk/stkinfo", {"mrkt_tp": "0"}, "list")
    assert len(rows) == 2 and complete is False and note == "continuation key repeated"


def test_pagination_marks_missing_key_and_page_ceiling(monkeypatch):
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_args, **_kwargs: Response({"list": [{}]}, has_next=True, next_key=None))
    _, complete, note = gateway._fetch_rows("ka10099", "/api/dostk/stkinfo", {"mrkt_tp": "0"}, "list")
    assert complete is False and note == "continuation key missing"

    sequence = iter(Response({"list": [{}]}, has_next=True, next_key=f"cursor-{index}") for index in range(32))
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_args, **_kwargs: next(sequence))
    rows, complete, note = gateway._fetch_rows("ka10099", "/api/dostk/stkinfo", {"mrkt_tp": "0"}, "list")
    assert len(rows) == 32 and complete is False and note == "pagination capped at 32 pages"


def test_fixture_cache_identity_does_not_cross_venue_or_live_book_staleness():
    ny = gateway.get_quote(market="US", stk_cd="BRK.B", stex_tp="NY", listing_venue="NYSE")
    wrong_venue = gateway.get_quote(market="US", stk_cd="BRK.B", stex_tp="ND", listing_venue="NASDAQ")
    assert ny["last"] is not None and wrong_venue["last"] is None and wrong_venue["status"] == "missing"
    stale_book = {key: ny[key] for key in ("environment", "market", "stkCd", "listingVenue", "quoteVenue")}
    stale_book.update({"asks": [{"price": 1.0, "qty": None}], "bids": [], "monotonicAt": 0.0})
    assert gateway.merge_book(ny, stale_book)["bookLive"] is False


def test_fixture_candles_have_valid_market_precision_bodies_and_wicks():
    kr = gateway.get_chart(market="KR", stk_cd="005930", stex_tp="KRX", listing_venue="KOSPI", interval="D")
    us = gateway.get_chart(market="US", stk_cd="BRK.B", stex_tp="NY", listing_venue="NYSE", interval="D")
    for chart in (kr, us):
        assert chart["source"] == "fixture" and chart["bars"]
        assert any(bar["o"] != bar["c"] for bar in chart["bars"])
        assert all(bar["h"] > max(bar["o"], bar["c"]) and bar["l"] < min(bar["o"], bar["c"]) for bar in chart["bars"])
    assert all(bar["o"].is_integer() and bar["h"].is_integer() and bar["l"].is_integer() and bar["c"].is_integer() for bar in kr["bars"])


def test_ft_symbol_and_missing_quantity_are_not_fabricated():
    identity = {"environment": "real", "market": "US", "stkCd": "BRK.B", "listingVenue": "NYSE", "quoteVenue": "NY", "stexTp": "NY"}
    assert book_hub._same_symbol({}, identity) is False
    asks, bids = book_hub._levels({"ask1": "100.5", "bid1": "100.0"})
    assert asks[0]["qty"] is None and bids[0]["qty"] is None


def test_store_v2_restart_keeps_market_identity_and_never_touches_legacy(tmp_path: Path):
    legacy = tmp_path / "watchlist.json"
    legacy.write_text('{"legacy": true}', encoding="utf-8")
    path = tmp_path / "watchlist-v2.json"
    first = AppStore(path)
    state = first.add_watchlist("mixed")
    group_id = next(row["id"] for row in state["watchlists"] if row["name"] == "mixed")
    first.add_item(group_id, {"market": "KR", "stkCd": "005930", "stkNm": "삼성전자", "listingVenue": "KOSPI"})
    first.add_item(group_id, {"market": "US", "stkCd": "BRK.B", "stkNm": "Berkshire", "stexTp": "NY", "listingVenue": "NYSE"})
    restored = AppStore(path).snapshot()
    assert {(row["market"], row["stkCd"], row["quoteVenue"]) for row in restored["items"]} == {("KR", "005930", "KRX"), ("US", "BRK.B", "NY")}
    assert legacy.read_text(encoding="utf-8") == '{"legacy": true}'
    assert path.exists()


def test_store_runtime_environment_overrides_forged_client_env_and_normalizes_reload(monkeypatch, tmp_path: Path):
    path = tmp_path / "watchlist-v2.json"
    monkeypatch.setattr(store_module, "ENVIRONMENT", "fixture")
    first = AppStore(path)
    group_id = first.add_watchlist("env")["watchlists"][-1]["id"]
    payload = {"market": "US", "stkCd": "BRK.B", "stkNm": "Berkshire", "stexTp": "NY", "listingVenue": "NYSE", "environment": "real", "last": 498.2, "prevClose": 495.0, "open": 496.1, "changePct": 0.65}
    first.add_item(group_id, payload)
    # Forging another environment cannot add a duplicate runtime identity.
    first.add_item(group_id, {**payload, "environment": "demo"})
    saved = first.snapshot()["items"]
    assert len(saved) == 1 and saved[0]["environment"] == "fixture"

    # Simulate a legacy/corrupt v2 file holding a second environment variant.
    raw = json.loads(path.read_text(encoding="utf-8"))
    duplicate = dict(raw["items"][0], id="duplicate", environment="demo")
    raw["items"].append(duplicate)
    path.write_text(json.dumps(raw), encoding="utf-8")

    monkeypatch.setattr(store_module, "ENVIRONMENT", "real")
    restored = AppStore(path).snapshot()["items"]
    assert len(restored) == 1
    item = restored[0]
    assert item["environment"] == "real"
    assert item["last"] is item["prevClose"] is item["open"] is item["changePct"] is None


def _portable_us(code: str = "AAPL") -> dict:
    return {
        "market": "US", "stkCd": code, "stkNm": "Apple" if code == "AAPL" else "Berkshire",
        "stexTp": "ND" if code == "AAPL" else "NY",
        "listingVenue": "NASDAQ" if code == "AAPL" else "NYSE",
        "quoteVenue": "ND" if code == "AAPL" else "NY", "currency": "USD",
    }


def test_portable_watchlists_merge_without_quotes_or_group_overwrite(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(store_module, "ENVIRONMENT", "fixture")
    local = AppStore(tmp_path / "watchlist-v2.json")
    existing = local.add_watchlist("장기 관찰")
    group = next(row for row in existing["watchlists"] if row["name"] == "장기 관찰")
    local.add_item(group["id"], _portable_us())

    next_state = local.import_local_watchlists([
        {"name": "장기 관찰", "instruments": [_portable_us(), _portable_us("BRK.B")]},
        {"name": "새 그룹", "instruments": []},
    ])

    same_group = next(row for row in next_state["watchlists"] if row["name"] == "장기 관찰")
    assert same_group == group
    rows = [row for row in next_state["items"] if row["watchlistId"] == group["id"]]
    assert {(row["stkCd"], row["environment"]) for row in rows} == {("AAPL", "fixture"), ("BRK.B", "fixture")}
    assert all(row[key] is None for row in rows for key in ("last", "prevClose", "open", "changePct"))


def test_portable_watchlist_persistence_rolls_back_memory_on_failure(monkeypatch, tmp_path: Path):
    local = AppStore(tmp_path / "watchlist-v2.json")
    before = deepcopy(local.snapshot())
    monkeypatch.setattr(local, "_persist_unlocked", lambda: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        local.import_local_watchlists([{"name": "새 그룹", "instruments": [_portable_us()]}])
    assert local.snapshot() == before


@pytest.mark.parametrize("raw", ["NaN", "Infinity", "-Infinity", "not-a-number"])
def test_non_finite_numbers_are_never_serialized(raw):
    assert gateway._number(raw) is None
