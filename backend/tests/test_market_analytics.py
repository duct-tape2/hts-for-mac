from __future__ import annotations

import pytest

from app import kiwoom_gateway as gateway
from app import market_analytics as analytics


def _instrument(code: str = "005930", venue: str = "KOSPI") -> dict:
    return {
        "market": "KR",
        "stkCd": code,
        "stkNm": "삼성전자",
        "stexTp": "KRX",
        "listingVenue": venue,
        "quoteVenue": "KRX",
        "currency": "KRW",
        "environment": "real",
    }


@pytest.fixture(autouse=True)
def clear_caches():
    analytics._clear_caches_for_tests()


def test_unknown_ranking_kind_is_rejected_before_index_or_transport(monkeypatch):
    monkeypatch.setattr(gateway, "_indexed", lambda _market: (_ for _ in ()).throw(AssertionError("index")))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("transport")))

    with pytest.raises(gateway.BrokerError, match="unsupported ranking kind"):
        analytics.get_rankings(kind="turnover", market="all")


def test_rankings_map_official_fields_units_identity_and_cache(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_indexed", lambda _market: ([
        _instrument(),
        _instrument("247540", "KOSDAQ"),
    ], True, ""))

    def fetch(api_id, path, body, list_key, *, max_pages):
        calls.append((api_id, path, body, list_key, max_pages))
        return ([
            {"stk_cd": "005930", "stk_nm": "untrusted name", "cur_prc": "-71500", "pred_pre": "+500", "flu_rt": "+0.70", "trde_qty": "1200000", "trde_amt": "85800"},
            {"stk_cd": "247540", "cur_prc": "0", "pred_pre": "-1000", "flu_rt": "-0.78", "trde_qty": "410000", "trde_amt": "52480"},
        ], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)

    result = analytics.get_rankings(kind="volume", market="all")
    cached = analytics.get_rankings(kind="volume", market="all")

    assert calls == [(
        "ka10030", "/api/dostk/rkinfo",
        {"mrkt_tp": "000", "sort_tp": "1", "mang_stk_incls": "0", "crd_tp": "0", "trde_qty_tp": "0", "pric_tp": "0", "trde_prica_tp": "0", "mrkt_open_tp": "0", "stex_tp": "1"},
        "tdy_trde_qty_upper", 5,
    )]
    assert result["source"] == "kiwoom"
    assert result["incomplete"] is False
    assert result["items"][0] == {
        "rank": 1,
        "instrument": _instrument(),
        "price": 71500.0,
        "change": 500.0,
        "changePct": 0.70,
        "volume": 1200000.0,
        "volumeUnit": "shares",
        "tradingValue": 85800.0,
        "tradingValueUnit": "KRW millions",
        "metric": 1200000.0,
        "metricUnit": "shares",
    }
    assert result["items"][1]["price"] is None
    assert cached == result


def test_rankings_omit_unresolved_listing_instead_of_defaulting_to_kospi(monkeypatch):
    provider_calls = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_indexed", lambda _market: ([], False, "KR symbol index is loading"))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: provider_calls.append(True))

    result = analytics.get_rankings(kind="value", market="all")

    assert result["items"] == []
    assert result["incomplete"] is True
    assert result["note"] == "KR symbol index is loading"
    assert provider_calls == []


def test_investor_flow_uses_whole_share_net_buy_contract_and_validated_identity(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_indexed", lambda _market: ([_instrument()], True, ""))

    def fetch(api_id, path, body, list_key, *, max_pages):
        calls.append((api_id, path, body, list_key, max_pages))
        return ([{"dt": body["dt"], "ind_invsr": "-1200", "frgnr_invsr": "+700", "orgn": "+500", "penfnd_etc": "+90"}], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)

    result = analytics.get_investor_flow(stk_cd="005930", listing_venue="KOSPI")

    assert calls[0][0:2] == ("ka10059", "/api/dostk/stkinfo")
    assert calls[0][2] == {"dt": result["date"], "stk_cd": "005930", "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1"}
    assert calls[0][3:] == ("stk_invsr_orgn", 5)
    assert result["instrument"] == _instrument()
    assert result["valueKind"] == "net_buy_quantity"
    assert result["unit"] == "shares"
    assert result["rows"] == [{
        "date": result["date"],
        "individual": -1200.0,
        "foreign": 700.0,
        "institutional": 500.0,
        "financialInvestment": None,
        "insurance": None,
        "investmentTrust": None,
        "otherFinancial": None,
        "bank": None,
        "pensionEtc": 90.0,
        "privateFund": None,
        "nation": None,
        "otherCorporation": None,
        "domesticForeign": None,
    }]


def test_investor_flow_rejects_listing_mismatch_before_provider_read(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_indexed", lambda _market: ([_instrument(venue="KOSDAQ")], True, ""))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("provider read")))

    with pytest.raises(gateway.BrokerError, match="requires symbol lookup"):
        analytics.get_investor_flow(stk_cd="005930", listing_venue="KOSPI")


def test_investor_flow_rejects_a_cold_symbol_index_before_provider_read(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_indexed", lambda _market: ([], False, "KR symbol index is loading in the background"))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("provider read")))

    with pytest.raises(analytics.IndexLoading, match="symbol index is loading"):
        analytics.get_investor_flow(stk_cd="005930", listing_venue="KOSPI")


def test_investor_flow_omits_non_calendar_provider_dates(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_indexed", lambda _market: ([_instrument()], True, ""))
    monkeypatch.setattr(
        gateway,
        "_fetch_rows",
        lambda *_args, **_kwargs: ([{"dt": "20261399", "ind_invsr": "1"}], True, ""),
    )

    result = analytics.get_investor_flow(stk_cd="005930", listing_venue="KOSPI")

    assert result["rows"] == []
    assert result["incomplete"] is True
    assert "1 investor rows omitted" in result["note"]
