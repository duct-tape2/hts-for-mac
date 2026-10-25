from types import SimpleNamespace

import pytest

from app import kiwoom_gateway as gateway
from app.store import AppStore


def test_us_watchlist_group_failure_is_not_normalized_to_an_empty_import(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_args, **_kwargs: SimpleNamespace(body={"rtcd": "F"}))

    with pytest.raises(gateway.BrokerError, match="해외 HTS 관심그룹 조회에 실패했습니다"):
        gateway.get_hts_watchlists("US")


def test_us_watchlist_detail_failure_propagates_before_any_empty_group_is_returned(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)

    def fetch(api_id, *_args, **_kwargs):
        if api_id == "usa20200":
            return SimpleNamespace(body={"rtcd": "S", "nofi": [{"gcod": "001", "name": "보존"}]})
        return SimpleNamespace(body={"rtcd": "F"})

    monkeypatch.setattr(gateway, "_fetch_page", fetch)

    with pytest.raises(gateway.BrokerError, match="해외 HTS 관심종목 조회에 실패했습니다"):
        gateway.get_hts_watchlists("US")


def test_us_watchlist_successful_empty_group_list_remains_a_genuine_empty_result(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_args, **_kwargs: SimpleNamespace(body={"rtcd": "S", "nofi": []}))

    assert gateway.get_hts_watchlists("US") == []


@pytest.mark.parametrize("groups_body", [
    {"rtcd": "S"},
    {"rtcd": "S", "nofi": {}},
    {"rtcd": "S", "nofi": ["not-a-group"]},
    {"rtcd": "S", "nofi": [{"gcod": "", "name": "bad"}]},
])
def test_us_watchlist_missing_or_malformed_group_list_is_never_normalized_to_empty(monkeypatch, groups_body):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_args, **_kwargs: SimpleNamespace(body=groups_body))

    with pytest.raises(gateway.BrokerError, match="기존 목록을 유지합니다"):
        gateway.get_hts_watchlists("US")


@pytest.mark.parametrize("detail_body", [
    {"rtcd": "S"},
    {"rtcd": "S", "nofj": {}},
    {"rtcd": "S", "nofj": [{"cod2": "BAD SYMBOL", "stex_tp": "ND"}]},
    {"rtcd": "S", "nofj": [{"cod2": "AAPL", "stex_tp": "XX"}]},
])
def test_us_watchlist_missing_or_invalid_detail_identity_fails_before_import(monkeypatch, detail_body):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)

    def fetch(api_id, *_args, **_kwargs):
        if api_id == "usa20200":
            return SimpleNamespace(body={"rtcd": "S", "nofi": [{"gcod": "001", "name": "보존"}]})
        return SimpleNamespace(body=detail_body)

    monkeypatch.setattr(gateway, "_fetch_page", fetch)
    with pytest.raises(gateway.BrokerError, match="기존 목록을 유지합니다"):
        gateway.get_hts_watchlists("US")


def test_us_watchlist_confirmed_empty_detail_group_is_allowed(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)

    def fetch(api_id, *_args, **_kwargs):
        return SimpleNamespace(body={"rtcd": "S", "nofi": [{"gcod": "001", "name": "빈 그룹"}]} if api_id == "usa20200" else {"rtcd": "S", "nofj": []})

    monkeypatch.setattr(gateway, "_fetch_page", fetch)
    assert gateway.get_hts_watchlists("US") == [{"gcod": "001", "name": "빈 그룹", "items": []}]


def test_us_watchlist_validation_failure_preserves_prior_imported_store_on_disk(monkeypatch, tmp_path):
    local = AppStore(tmp_path / "watchlist-v2.json")
    existing = gateway._identity(market="US", stk_cd="AAPL", stex_tp="ND", listing_venue="NASDAQ")
    local.import_kiwoom("unused", [{"gcod": "001", "name": "보존", "items": [{**existing, "stkNm": "AAPL"}]}])
    before = local.snapshot()
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)

    def fetch(api_id, *_args, **_kwargs):
        if api_id == "usa20200":
            return SimpleNamespace(body={"rtcd": "S", "nofi": [{"gcod": "001", "name": "덮어쓰면 안 됨"}]})
        return SimpleNamespace(body={"rtcd": "S", "nofj": [{"cod2": "AAPL", "stex_tp": "invalid"}]})

    monkeypatch.setattr(gateway, "_fetch_page", fetch)
    with pytest.raises(gateway.BrokerError, match="기존 목록을 유지합니다"):
        local.import_kiwoom("unused", gateway.get_hts_watchlists("US"))
    assert local.snapshot() == before
    reloaded = AppStore(tmp_path / "watchlist-v2.json").snapshot()
    assert reloaded["watchlists"] == before["watchlists"] and reloaded["items"] == before["items"]
