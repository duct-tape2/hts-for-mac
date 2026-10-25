from __future__ import annotations

import pytest

from app import analysis_kr_extra as analysis
from app import kiwoom_gateway as gateway


def _instrument(code: str = "005930") -> dict:
    return {
        "market": "KR", "stkCd": code, "stkNm": "삼성전자", "stexTp": "KRX",
        "listingVenue": "KOSPI", "quoteVenue": "KRX", "currency": "KRW", "environment": "real",
    }


def _real(monkeypatch, rows: list[dict] | None = None):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_indexed", lambda _market: (rows if rows is not None else [_instrument()], True, ""))


def test_metadata_is_fixed_and_allowlist_is_only_a_proposal():
    assert set(analysis.FEATURES) == {
        "kr_expected_execution_rank", "kr_orderbook_quantity_surge", "kr_orderbook_ratio_surge",
        "kr_price_concentration", "kr_after_hours_single_price_rank", "kr_today_previous_execution_volume",
    }
    assert analysis.ALLOWED_CALLS == {
        ("ka10021", "/api/dostk/rkinfo"), ("ka10022", "/api/dostk/rkinfo"),
        ("ka10025", "/api/dostk/stkinfo"), ("ka10029", "/api/dostk/rkinfo"),
        ("ka10055", "/api/dostk/stkinfo"), ("ka10098", "/api/dostk/rkinfo"),
    }
    assert all(meta["market"] == "KR" and meta["parameters"] for meta in analysis.FEATURES.values())


def test_expected_execution_uses_exact_contract_and_keeps_it_separate_from_ohlc(monkeypatch):
    _real(monkeypatch, [_instrument("000660")])
    calls: list[tuple] = []

    def fetch(api_id, path, body, list_key, *, max_pages):
        calls.append((api_id, path, body, list_key, max_pages))
        return ([{
            "stk_cd": "000660", "stk_nm": "untrusted", "exp_cntr_pric": "-71500", "base_pric": "71000",
            "pred_pre_sig": "5", "pred_pre": "-500", "flu_rt": "-0.70", "exp_cntr_qty": "12",
            "sel_req": "7", "sel_bid": "-71600", "buy_bid": "-71500", "buy_req": "9",
        }], False, "more rows")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    result = analysis.get_feature("kr_expected_execution_rank", {
        "market": "101", "sort": "4", "minimumVolume": "10", "stockFilter": "16", "creditFilter": "9", "priceFilter": "5", "venue": "2",
    })

    assert calls == [("ka10029", "/api/dostk/rkinfo", {
        "mrkt_tp": "101", "sort_tp": "4", "trde_qty_cnd": "10", "stk_cnd": "16", "crd_cnd": "9", "pric_cnd": "5", "stex_tp": "2",
    }, "exp_cntr_flu_rt_upper", 5)]
    assert result["status"] == "snapshot"
    assert result["complete"] is False
    assert result["note"] == "more rows"
    assert result["asOf"] is None
    assert result["rows"] == [{
        "code": "000660", "name": "untrusted", "expectedPrice": 71500.0, "basePrice": 71000.0, "changeSign": "5", "change": -500.0,
        "changePct": -0.7, "expectedQuantity": 12.0, "askQuantity": 7.0, "ask": 71600.0, "bid": 71500.0, "bidQuantity": 9.0,
        "id": "kr_expected_execution_rank:000660:1", "instrument": _instrument("000660"),
    }]


def test_book_surges_and_after_hours_send_only_documented_fields(monkeypatch):
    _real(monkeypatch)
    calls: list[tuple] = []

    def fetch(api_id, path, body, list_key, *, max_pages):
        calls.append((api_id, path, body, list_key, max_pages))
        return ([], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    quantity = analysis.get_feature("kr_orderbook_quantity_surge", {"market": "101", "side": "2", "sort": "2", "minutes": "30", "minimumVolume": "50", "stockFilter": "9", "venue": "1"})
    ratio = analysis.get_feature("kr_orderbook_ratio_surge", {"market": "001", "ratioSide": "2", "minutes": 1, "minimumVolume": "100", "stockFilter": "1", "venue": "2"})
    after = analysis.get_feature("kr_after_hours_single_price_rank", {"market": "101", "sort": "4", "stockFilter": "17", "minimumVolume": "500", "creditFilter": "8", "minimumValue": "300"})

    assert calls == [
        ("ka10021", "/api/dostk/rkinfo", {"mrkt_tp": "101", "trde_tp": "2", "sort_tp": "2", "tm_tp": "30", "trde_qty_tp": "50", "stk_cnd": "9", "stex_tp": "1"}, "bid_req_sdnin", 5),
        ("ka10022", "/api/dostk/rkinfo", {"mrkt_tp": "001", "rt_tp": "2", "tm_tp": "1", "trde_qty_tp": "100", "stk_cnd": "1", "stex_tp": "2"}, "req_rt_sdnin", 5),
        ("ka10098", "/api/dostk/rkinfo", {"mrkt_tp": "101", "sort_base": "4", "stk_cnd": "17", "trde_qty_cnd": "500", "crd_cnd": "8", "trde_prica": "300"}, "ovt_sigpric_flu_rt_rank", 5),
    ]
    assert quantity["status"] == ratio["status"] == after["status"] == "missing"
    assert all(item["complete"] is True for item in (quantity, ratio, after))


def test_price_concentration_and_execution_volume_validate_before_transport(monkeypatch):
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("transport")))
    with pytest.raises(gateway.BrokerError, match="invalid concentrationPct"):
        analysis.get_feature("kr_price_concentration", {"concentrationPct": "101"})
    with pytest.raises(gateway.BrokerError, match="invalid minutes"):
        analysis.get_feature("kr_orderbook_ratio_surge", {"minutes": "100"})
    with pytest.raises(gateway.BrokerError, match="stockCode is required"):
        analysis.get_feature("kr_today_previous_execution_volume", {})
    with pytest.raises(gateway.BrokerError, match="unsupported feature parameter"):
        analysis.get_feature("kr_after_hours_single_price_rank", {"venue": "3"})


def test_execution_volume_keeps_hhmmss_without_inventing_date_and_fixture_never_requests(monkeypatch):
    _real(monkeypatch)
    calls: list[tuple] = []

    def fetch(api_id, path, body, list_key, *, max_pages):
        calls.append((api_id, path, body, list_key, max_pages))
        return ([{"cntr_tm": "154626", "cntr_pric": "-74800", "pred_pre_sig": "5", "pred_pre": "-600", "flu_rt": "-0.80", "cntr_qty": "-3", "acc_trde_qty": "444401", "acc_trde_prica": "33090"}], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    result = analysis.get_feature("kr_today_previous_execution_volume", {"day": "2"}, instrument=_instrument())
    assert calls == [("ka10055", "/api/dostk/stkinfo", {"stk_cd": "005930", "tdy_pred": "2"}, "tdy_pred_cntr_qty", 5)]
    assert result["asOf"] is None
    assert result["rows"][0]["executionTime"] == "154626"
    assert result["rows"][0]["executionQuantity"] == -3.0
    assert result["rows"][0]["accumulatedValue"] == 33090.0

    # The API route's canonical identity has no display name.  If the shared
    # index cannot verify one, use only its public code as the display value;
    # never attach a provider-row name as a trusted Instrument.
    _real(monkeypatch, [])
    result = analysis.get_feature("kr_today_previous_execution_volume", {"day": "1"}, instrument={
        "market": "KR", "stkCd": "005930", "stexTp": "KRX", "listingVenue": "KOSPI",
        "quoteVenue": "KRX", "currency": "KRW", "environment": "real",
    })
    assert result["rows"][0]["instrument"] == {
        "market": "KR", "stkCd": "005930", "stkNm": "005930", "stexTp": "KRX",
        "listingVenue": "KOSPI", "quoteVenue": "KRX", "currency": "KRW", "environment": "real",
    }

    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", False)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "fixture")
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("fixture transport")))
    fixture = analysis.get_feature("kr_price_concentration", {})
    assert fixture["source"] == fixture["status"] == "fixture"
    assert fixture["complete"] is True


def test_disabled_and_broker_failure_are_honest_and_never_fall_back(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", False)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    disabled = analysis.get_feature("kr_price_concentration", {})
    assert disabled["source"] == "kiwoom"
    assert disabled["status"] == "error"
    assert disabled["complete"] is False
    assert disabled["rows"] == []

    _real(monkeypatch)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(gateway.BrokerError("no")))
    failed = analysis.get_feature("kr_price_concentration", {})
    assert failed["status"] == "error"
    assert failed["complete"] is False
    assert failed["rows"] == []

    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(gateway.BrokerError("unsupported", provider_code=1504)))
    after_hours = analysis.get_feature("kr_after_hours_single_price_rank", {})
    assert after_hours["status"] == "error"
    assert after_hours["complete"] is False
    assert after_hours["rows"] == []
    assert after_hours["note"] == "키움이 이 API와 경로 조합을 지원하지 않는다고 응답했습니다(1504). 대체 가격은 표시하지 않습니다."
