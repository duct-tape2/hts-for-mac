from types import SimpleNamespace

import pytest

from app import kiwoom_gateway as gateway
from app.store import AppStore


def test_domestic_import_preserves_leading_zero_and_market_namespace(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    item = gateway._identity(market="KR", stk_cd="005930", stex_tp="KRX", listing_venue="KOSPI")
    monkeypatch.setattr(gateway, "_indexed", lambda _: ([item], True, ""))
    calls = []

    def fetch(api_id, path, body):
        calls.append((api_id, path, body))
        return SimpleNamespace(body={"rtcd": "S", "nofi": [{"gcod": "001", "name": "관찰"}]} if api_id == "ka01300" else {"rtcd": "S", "nofj": [{"cod2": "A005930"}]})

    monkeypatch.setattr(gateway, "_fetch_page", fetch)
    groups = gateway.get_hts_watchlists("KR")
    assert groups[0]["gcod"] == "KR_001"
    assert groups[0]["items"][0]["stkCd"] == "005930"
    assert groups[0]["items"][0]["listingVenue"] == "KOSPI"
    assert calls == [
        ("ka01300", "/api/dostk/watchlist", {}),
        ("ka01301", "/api/dostk/watchlist", {"arn_grp_id": "001"}),
    ]


def test_domestic_import_never_replaces_existing_group_with_partial_unknown_codes(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_indexed", lambda _: ([], True, ""))
    monkeypatch.setattr(gateway, "_fetch_page", lambda api_id, *_: SimpleNamespace(body={"rtcd": "S", "nofi": [{"gcod": "001", "name": "관찰"}]} if api_id == "ka01300" else {"rtcd": "S", "nofj": [{"cod2": "005930"}]}))
    with pytest.raises(gateway.BrokerError, match="기존 목록"):
        gateway.get_hts_watchlists("KR")


@pytest.mark.parametrize("groups_body", [
    {"rtcd": "S"},
    {"rtcd": "S", "nofi": {}},
    {"rtcd": "S", "nofi": ["not-a-group"]},
    {"rtcd": "S", "nofi": [{"gcod": "001", "name": ""}]},
])
def test_domestic_missing_or_malformed_group_list_fails_instead_of_importing_empty(monkeypatch, groups_body):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_indexed", lambda _: ([], True, ""))
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_args, **_kwargs: SimpleNamespace(body=groups_body))
    with pytest.raises(gateway.BrokerError, match="기존 목록을 유지합니다"):
        gateway.get_hts_watchlists("KR")


@pytest.mark.parametrize("detail_body", [
    {"rtcd": "S"},
    {"rtcd": "S", "nofj": {}},
    {"rtcd": "S", "nofj": [{"cod2": "BAD CODE"}]},
    {"rtcd": "S", "nofj": [{"cod2": 5930}]},
])
def test_domestic_missing_or_malformed_detail_fails_before_import(monkeypatch, detail_body):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    item = gateway._identity(market="KR", stk_cd="005930", stex_tp="KRX", listing_venue="KOSPI")
    monkeypatch.setattr(gateway, "_indexed", lambda _: ([item], True, ""))
    monkeypatch.setattr(gateway, "_fetch_page", lambda api_id, *_args, **_kwargs: SimpleNamespace(body={"rtcd": "S", "nofi": [{"gcod": "001", "name": "보존"}]} if api_id == "ka01300" else detail_body))
    with pytest.raises(gateway.BrokerError, match="기존 목록을 유지합니다"):
        gateway.get_hts_watchlists("KR")


def test_domestic_confirmed_empty_groups_and_details_are_allowed(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_indexed", lambda _: ([], True, ""))
    monkeypatch.setattr(gateway, "_fetch_page", lambda api_id, *_args, **_kwargs: SimpleNamespace(body={"rtcd": "S", "nofi": []} if api_id == "ka01300" else {"rtcd": "S", "nofj": []}))
    assert gateway.get_hts_watchlists("KR") == []

    item = gateway._identity(market="KR", stk_cd="005930", stex_tp="KRX", listing_venue="KOSPI")
    monkeypatch.setattr(gateway, "_indexed", lambda _: ([item], True, ""))
    monkeypatch.setattr(gateway, "_fetch_page", lambda api_id, *_args, **_kwargs: SimpleNamespace(body={"rtcd": "S", "nofi": [{"gcod": "001", "name": "빈 그룹"}]} if api_id == "ka01300" else {"rtcd": "S", "nofj": []}))
    assert gateway.get_hts_watchlists("KR") == [{"gcod": "KR_001", "name": "빈 그룹", "items": []}]


def test_domestic_validation_failure_preserves_prior_imported_store_on_disk(monkeypatch, tmp_path):
    local = AppStore(tmp_path / "watchlist-v2.json")
    existing = gateway._identity(market="KR", stk_cd="005930", stex_tp="KRX", listing_venue="KOSPI")
    local.import_kiwoom("unused", [{"gcod": "KR_001", "name": "보존", "items": [{**existing, "stkNm": "삼성전자"}]}])
    before = local.snapshot()
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_indexed", lambda _: ([existing], True, ""))
    monkeypatch.setattr(gateway, "_fetch_page", lambda api_id, *_args, **_kwargs: SimpleNamespace(body={"rtcd": "S", "nofi": [{"gcod": "001", "name": "덮어쓰면 안 됨"}]} if api_id == "ka01300" else {"rtcd": "S", "nofj": [{"cod2": "invalid"}]}))

    with pytest.raises(gateway.BrokerError, match="기존 목록을 유지합니다"):
        local.import_kiwoom("unused", gateway.get_hts_watchlists("KR"))
    assert local.snapshot() == before
    reloaded = AppStore(tmp_path / "watchlist-v2.json").snapshot()
    assert reloaded["watchlists"] == before["watchlists"] and reloaded["items"] == before["items"]


def test_invalid_market_rejected_before_any_network(monkeypatch):
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_: pytest.fail("unexpected network call"))
    with pytest.raises(gateway.BrokerError):
        gateway.get_hts_watchlists("orders")
