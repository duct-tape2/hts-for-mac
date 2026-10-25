from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import analysis_kr as analysis
from app import kiwoom_gateway as gateway


def _instrument(code: str = "005930") -> dict:
    return {
        "market": "KR",
        "stkCd": code,
        "stkNm": "삼성전자",
        "stexTp": "KRX",
        "listingVenue": "KOSPI",
        "quoteVenue": "KRX",
        "currency": "KRW",
        "environment": "real",
    }


@pytest.fixture(autouse=True)
def _clear_cache():
    analysis._clear_caches_for_tests()


def _real_index(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_indexed", lambda _market: ([_instrument()], True, ""))


def test_metadata_and_review_allowlist_are_complete_and_read_only():
    assert set(analysis.FEATURES) == {
        "kr_tape", "kr_brokers", "kr_foreign_holding", "kr_credit_trend",
        "kr_short_sale", "kr_lending", "kr_program_rank", "kr_program_stock",
        "kr_program_intraday", "kr_program_arbitrage_balance", "kr_program_stock_daily",
        "kr_theme_groups", "kr_theme_constituents", "kr_etf_returns", "kr_etf_info",
        "kr_etf_all_quotes", "kr_etf_nav", "kr_new_high_low", "kr_high_low_proximity",
        "kr_price_surge", "kr_orderbook_balance_rank", "kr_volume_surge", "kr_volume_renewal",
        "kr_valuation_extremes", "kr_credit_ratio_rank", "kr_foreign_period_rank",
        "kr_fundamentals", "kr_ohlcv_flow", "kr_daily_trade_sessions", "kr_daily_price", "kr_vi_events",
        "kr_institution_daily_rank", "kr_institution_stock_trend", "kr_strength_intraday", "kr_strength_daily",
        "kr_investor_daily_rank", "kr_investor_stock_chart", "kr_investor_stock_total", "kr_intraday_investor_rank",
        "kr_intraday_investor_chart", "kr_after_close_investor", "kr_program_accumulated", "kr_program_stock_intraday",
        "kr_program_daily_trend", "kr_minute_quote_raw", "kr_price_profile_raw", "kr_after_hours_book_raw",
    }
    assert ("ka10003", "/api/dostk/stkinfo") in analysis.ALLOWED_CALLS
    assert ("ka90005", "/api/dostk/mrkcond") in analysis.ALLOWED_CALLS
    assert ("ka40009", "/api/dostk/etf") in analysis.ALLOWED_CALLS
    assert ("ka10016", "/api/dostk/stkinfo") in analysis.ALLOWED_CALLS
    assert ("ka10034", "/api/dostk/rkinfo") in analysis.ALLOWED_CALLS
    assert ("ka10001", "/api/dostk/stkinfo") in analysis.ALLOWED_CALLS
    assert ("ka10054", "/api/dostk/stkinfo") in analysis.ALLOWED_CALLS
    assert ("ka90008", "/api/dostk/mrkcond") in analysis.ALLOWED_CALLS
    assert ("ka90010", "/api/dostk/mrkcond") in analysis.ALLOWED_CALLS
    assert ("ka10087", "/api/dostk/mrkcond") in analysis.ALLOWED_CALLS
    assert all(feature["market"] == "KR" and feature["parameters"] for feature in analysis.FEATURES.values())
    assert all(
        parameter["default"].count("-") == 2
        for feature in analysis.FEATURES.values()
        for parameter in feature["parameters"]
        if parameter["type"] == "date"
    )


def test_tape_uses_exact_gateway_contract_preserves_signs_and_attaches_indexed_instrument(monkeypatch):
    _real_index(monkeypatch)
    calls: list[tuple] = []

    def fetch(api_id, path, body, list_key, *, max_pages):
        calls.append((api_id, path, body, list_key, max_pages))
        return ([{
            "tm": "090001", "cur_prc": "-71500", "pred_pre": "-500", "pre_rt": "-0.69",
            "pri_sel_bid_unit": "-71600", "pri_buy_bid_unit": "-71500", "cntr_trde_qty": "-10",
            "acc_trde_qty": "100", "acc_trde_prica": "5000", "cntr_str": "99.25", "stex_tp": "KRX",
        }], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    result = analysis.get_feature("kr_tape", {}, instrument=_instrument())

    assert calls == [("ka10003", "/api/dostk/stkinfo", {"stk_cd": "005930"}, "cntr_infr", 5)]
    assert result["source"] == "kiwoom"
    assert result["status"] == "snapshot"
    assert result["complete"] is True
    assert result["asOf"] is None
    assert result["scope"]["resolvedStockCode"] == "005930"
    assert result["scope"]["requestedInstrument"]["stkCd"] == "005930"
    assert result["scope"]["requestedInstrument"]["market"] == "KR"
    assert result["rows"] == [{
        "time": "090001", "price": 71500.0, "change": -500.0, "changePct": -0.69,
        "ask": 71600.0, "bid": 71500.0, "tradeQuantity": -10.0,
        "accumulatedVolume": 100.0, "accumulatedValue": 5000.0, "strength": 99.25,
        "venue": "KRX", "id": "kr_tape:090001:1", "instrument": _instrument(),
    }]


def test_provider_direction_prefix_is_removed_for_all_price_sources_but_not_comparisons():
    for source in analysis._PRICE_SOURCES:
        assert analysis._value({source: "-213500"}, source, True, "number") == 213500.0
    assert analysis._value({"pred_pre": "-500"}, "pred_pre", True, "number") == -500.0
    assert analysis._value({"netprps_qty": "-2"}, "netprps_qty", True, "number") == -2.0


def test_invalid_or_conditionally_missing_inputs_fail_before_index_or_transport(monkeypatch):
    monkeypatch.setattr(gateway, "_indexed", lambda _market: (_ for _ in ()).throw(AssertionError("index")))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("transport")))

    with pytest.raises(gateway.BrokerError, match="unsupported KR analysis feature"):
        analysis.get_feature("raw_api", {})
    with pytest.raises(gateway.BrokerError, match="stockCode is required"):
        analysis.get_feature("kr_theme_groups", {"queryType": "2"})
    with pytest.raises(gateway.BrokerError, match="themeCode is required"):
        analysis.get_feature("kr_theme_constituents", {})
    with pytest.raises(gateway.BrokerError, match="indexCode is required"):
        analysis.get_feature("kr_etf_returns", {"stockCode": "005930"})
    with pytest.raises(gateway.BrokerError, match="invalid venue"):
        analysis.get_feature("kr_program_rank", {"venue": "0"})
    with pytest.raises(gateway.BrokerError, match="unsupported feature parameter"):
        analysis.get_feature("kr_price_surge", {"apiId": "ka10019"})
    with pytest.raises(gateway.BrokerError, match="invalid market"):
        analysis.get_feature("kr_orderbook_balance_rank", {"market": "000"})
    with pytest.raises(gateway.BrokerError, match="startDate must not"):
        analysis.get_feature("kr_short_sale", {"stockCode": "005930", "startDate": "20261025", "endDate": "20261024"})


def test_broker_scalar_uses_fetch_page_only_and_omits_empty_ranks(monkeypatch):
    _real_index(monkeypatch)
    calls: list[tuple] = []
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("list transport")))

    def page(api_id, path, body, **kwargs):
        calls.append((api_id, path, body, kwargs))
        return SimpleNamespace(body={"sel_trde_ori_nm_1": "가상매도", "sel_trde_ori_1": "001", "sel_trde_qty_1": "-1200"})

    monkeypatch.setattr(gateway, "_fetch_page", page)
    result = analysis.get_feature("kr_brokers", {"stockCode": "005930"})

    assert calls == [("ka10002", "/api/dostk/stkinfo", {"stk_cd": "005930"}, {})]
    assert result["rows"] == [{
        "id": "kr_brokers:sell:1", "side": "매도", "rank": 1, "broker": "가상매도",
        "brokerCode": "001", "quantity": -1200.0, "instrument": _instrument(),
    }]


def test_program_intraday_selects_proven_market_venue_code_and_bounded_pagination(monkeypatch):
    _real_index(monkeypatch)
    calls: list[tuple] = []

    def fetch(api_id, path, body, list_key, *, max_pages):
        calls.append((api_id, path, body, list_key, max_pages))
        return ([{"cntr_tm": "091000", "all_netprps": "-35"}], False, "more rows")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    result = analysis.get_feature("kr_program_intraday", {
        "date": "2026-10-24", "amountQuantity": "2", "market": "P101", "intervalType": "1", "venue": "2",
    })

    assert calls == [(
        "ka90005", "/api/dostk/mrkcond",
        {"date": "20261024", "amt_qty_tp": "2", "mrkt_tp": "P101_NX02", "min_tic_tp": "1", "stex_tp": "2"},
        "prm_trde_trnsn", 5,
    )]
    assert result["complete"] is False
    assert result["note"] == "more rows"
    assert result["rows"][0]["totalNet"] == -35.0
    assert result["rows"][0]["arbitrageSell"] is None


def test_price_surge_uses_all_proven_filters_and_attaches_row_not_panel_identity(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_indexed", lambda _market: ([_instrument(), _instrument("000660")], True, ""))

    def fetch(api_id, path, body, list_key, *, max_pages):
        calls.append((api_id, path, body, list_key, max_pages))
        return ([{
            "stk_cd": "000660", "stk_cls": "", "stk_nm": "untrusted", "pred_pre_sig": "5",
            "pred_pre": "-800", "flu_rt": "-0.95", "base_pric": "-66000", "cur_prc": "-65200",
            "base_pre": "-800", "trde_qty": "100", "jmp_rt": "-1.21",
        }], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    result = analysis.get_feature("kr_price_surge", {
        "market": "201", "direction": "2", "timeType": "2", "lookback": "10", "minimumVolume": "00100",
        "stockFilter": "3", "creditFilter": "9", "priceFilter": "5", "includeLimit": "1", "venue": "3",
    }, instrument=_instrument())

    assert calls == [(
        "ka10019", "/api/dostk/stkinfo",
        {"mrkt_tp": "201", "flu_tp": "2", "tm_tp": "2", "tm": "10", "trde_qty_tp": "00100", "stk_cnd": "3", "crd_cnd": "9", "pric_cnd": "5", "updown_incls": "1", "stex_tp": "3"},
        "pric_jmpflu", 5,
    )]
    assert result["rows"] == [{
        "code": "000660", "classification": None, "name": "untrusted", "changeSign": "5", "change": -800.0,
        "changePct": -0.95, "basePrice": 66000.0, "price": 65200.0, "baseChange": -800.0,
        "volume": 100.0, "surgePct": -1.21, "id": "kr_price_surge:000660:1", "instrument": _instrument("000660"),
    }]
    assert next(column for column in result["columns"] if column["key"] == "volume")["unit"] == "shares"


def test_volume_surge_omits_minute_filter_for_previous_day_and_foreign_rank_keeps_signed_quantity(monkeypatch):
    _real_index(monkeypatch)
    calls: list[tuple] = []

    def fetch(api_id, path, body, list_key, *, max_pages):
        calls.append((api_id, path, body, list_key, max_pages))
        if api_id == "ka10023":
            return ([], True, "")
        return ([{"rank": "1", "stk_cd": "005930", "stk_nm": "untrusted", "cur_prc": "+70000", "pred_pre": "+500", "sel_bid": "+70100", "buy_bid": "-69900", "trde_qty": "10", "netprps_qty": "-4", "gain_pos_stkcnt": "9"}], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    analysis.get_feature("kr_volume_surge", {"timeType": "2", "lookback": "99"})
    ranked = analysis.get_feature("kr_foreign_period_rank", {"market": "101", "tradeType": "3", "period": "20", "venue": "2"})

    assert calls[0] == (
        "ka10023", "/api/dostk/rkinfo",
        {"mrkt_tp": "000", "sort_tp": "1", "tm_tp": "2", "trde_qty_tp": "5", "stk_cnd": "0", "pric_tp": "0", "stex_tp": "1"},
        "trde_qty_sdnin", 5,
    )
    assert calls[1] == (
        "ka10034", "/api/dostk/rkinfo", {"mrkt_tp": "101", "trde_tp": "3", "dt": "20", "stex_tp": "2"}, "for_dt_trde_upper", 5,
    )
    assert ranked["rows"][0]["instrument"] == _instrument()
    assert ranked["rows"][0]["netTradeQuantity"] == -4.0
    assert ranked["rows"][0]["bid"] == 69900.0


def test_ka90013_double_signed_change_is_preserved_as_explicit_unparsed_raw_value(monkeypatch):
    _real_index(monkeypatch)

    def fetch(api_id, path, body, list_key, *, max_pages):
        assert (api_id, path, body, list_key, max_pages) == (
            "ka90013", "/api/dostk/mrkcond", {"amt_qty_tp": "1", "stk_cd": "005930", "date": "20261024"}, "stk_daly_prm_trde_trnsn", 5,
        )
        return ([
            {"dt": "20261024", "cur_prc": "-71500", "pred_pre": "-500", "prm_netprps_amt_irds": "--6", "prm_netprps_qty_irds": "--19", "prm_netprps_amt": "-10", "prm_netprps_qty": "-20"},
            {"dt": "20261023", "cur_prc": "-71000", "pred_pre": "-100", "prm_netprps_amt_irds": "4", "prm_netprps_qty_irds": "5"},
        ], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    result = analysis.get_feature("kr_program_stock_daily", {"date": "2026-10-24"}, instrument=_instrument())

    row = result["rows"][0]
    assert row["price"] == 71500.0
    assert row["programNetAmount"] == -10.0
    assert row["programNetQuantity"] == -20.0
    assert row["programNetAmountChange"] is None
    assert row["programNetAmountChangeRaw"] == "--6"
    assert row["programNetQuantityChange"] is None
    assert row["programNetQuantityChangeRaw"] == "--19"
    assert {column["key"] for column in result["columns"]} >= {"programNetAmountChangeRaw", "programNetQuantityChangeRaw"}
    assert result["rows"][1]["programNetAmountChangeRaw"] is None
    assert result["rows"][1]["programNetQuantityChangeRaw"] is None
    assert "Provider numeric values left unparsed" in result["note"]


def test_fixture_is_explicit_and_never_a_live_failure_fallback(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", False)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "fixture")
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("live transport")))

    fixture = analysis.get_feature("kr_etf_all_quotes", {})
    assert fixture["source"] == "fixture"
    assert fixture["status"] == "fixture"
    assert fixture["receivedAt"] == "2026-10-24T00:00:00Z"
    assert fixture["rows"]
    assert analysis.get_feature("kr_program_stock", {})["parameters"]["date"] == "20261024"

    analysis._clear_caches_for_tests()
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    unavailable = analysis.get_feature("kr_etf_all_quotes", {})
    assert unavailable["source"] == "kiwoom"
    assert unavailable["status"] == "error"
    assert unavailable["rows"] == []


def test_provider_failure_is_normalized_and_does_not_surface_raw_error(monkeypatch):
    _real_index(monkeypatch)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(gateway.BrokerError("token words must not leak")))

    result = analysis.get_feature("kr_lending", {"startDate": "20261001", "endDate": "20261024"})

    assert result["status"] == "error"
    assert result["complete"] is False
    assert result["note"] == "키움 조회를 완료하지 못했습니다. 연결 상태와 조회 조건을 확인하세요."
    assert result["rows"] == []


def test_fundamentals_scalar_uses_exact_contract_and_keeps_price_vs_change_semantics(monkeypatch):
    _real_index(monkeypatch)
    calls: list[tuple] = []

    def page(api_id, path, body, **kwargs):
        calls.append((api_id, path, body, kwargs))
        return SimpleNamespace(body={"stk_cd": "005930", "stk_nm": "untrusted", "fav": "5000", "per": "12.3", "cur_prc": "-71500", "pred_pre": "-500", "flu_rt": "-0.69", "trde_qty": "123"})

    monkeypatch.setattr(gateway, "_fetch_page", page)
    result = analysis.get_feature("kr_fundamentals", {}, instrument=_instrument())

    assert calls == [("ka10001", "/api/dostk/stkinfo", {"stk_cd": "005930"}, {})]
    assert result["rows"][0]["price"] == 71500.0
    assert result["rows"][0]["change"] == -500.0
    assert result["rows"][0]["faceValue"] == 5000.0
    assert result["rows"][0]["instrument"] == _instrument()


def test_vi_bounds_and_program_accumulated_contracts_are_validated_before_transport(monkeypatch):
    monkeypatch.setattr(gateway, "_indexed", lambda _market: (_ for _ in ()).throw(AssertionError("index")))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("transport")))

    with pytest.raises(gateway.BrokerError, match="required when the filter is enabled"):
        analysis.get_feature("kr_vi_events", {"volumeFilter": "1", "minimumVolume": "", "maximumVolume": ""})

    _real_index(monkeypatch)
    calls: list[tuple] = []

    def fetch(api_id, path, body, list_key, *, max_pages):
        calls.append((api_id, path, body, list_key, max_pages))
        return ([{"dt": "20261024", "dfrt_trde_tdy": "-12", "all_acc": "+45"}], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    result = analysis.get_feature("kr_program_accumulated", {"date": "2026-10-24", "amountQuantity": "2", "market": "1", "venue": "3"})

    assert calls == [("ka90007", "/api/dostk/mrkcond", {"date": "20261024", "amt_qty_tp": "2", "mrkt_tp": "1", "stex_tp": "3"}, "prm_trde_acc_trnsn", 5)]
    assert result["rows"][0]["arbitrageToday"] == -12.0
    assert result["rows"][0]["totalAccumulated"] == 45.0


def test_vi_optional_empty_root_is_missing_and_selected_instrument_constrains_request(monkeypatch):
    _real_index(monkeypatch)
    calls: list[tuple] = []

    def page(api_id, path, body, **kwargs):
        calls.append((api_id, path, body, kwargs))
        return SimpleNamespace(body={})

    monkeypatch.setattr(gateway, "_fetch_page", page)
    result = analysis.get_feature("kr_vi_events", {}, instrument=_instrument())

    assert calls == [(
        "ka10054", "/api/dostk/stkinfo",
        {"mrkt_tp": "000", "bf_mkrt_tp": "0", "stk_cd": "005930", "motn_tp": "0", "skip_stk": "000000000",
         "trde_qty_tp": "1", "min_trde_qty": "0", "max_trde_qty": "100000000", "trde_prica_tp": "1",
         "min_trde_prica": "0", "max_trde_prica": "100000000", "motn_drc": "0", "stex_tp": "1"},
        {"cont_yn": None, "next_key": None},
    )]
    assert result["status"] == "missing"
    assert result["complete"] is True
    assert result["rows"] == []
    assert result["scope"]["resolvedStockCode"] == "005930"
    defaults = {parameter["key"]: parameter["default"] for parameter in analysis.FEATURES["kr_vi_events"]["parameters"]}
    assert {key: defaults[key] for key in ("volumeFilter", "minimumVolume", "maximumVolume", "valueFilter", "minimumValue", "maximumValue")} == {
        "volumeFilter": "1", "minimumVolume": "0", "maximumVolume": "100000000",
        "valueFilter": "1", "minimumValue": "0", "maximumValue": "100000000",
    }


def test_after_hours_missing_scalar_book_stays_error_with_specific_safe_note(monkeypatch):
    _real_index(monkeypatch)
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_args, **_kwargs: SimpleNamespace(body={}))

    result = analysis.get_feature("kr_after_hours_book_raw", {}, instrument=_instrument())

    assert result["status"] == "error"
    assert result["complete"] is False
    assert result["rows"] == []
    assert result["note"] == "Kiwoom did not return the documented after-hours book."


def test_scalar_quote_raw_preserves_signed_provider_strings_and_missing_fields_are_an_error(monkeypatch):
    _real_index(monkeypatch)
    calls: list[tuple] = []

    def page(api_id, path, body, **kwargs):
        calls.append((api_id, path, body, kwargs))
        if api_id == "ka10006":
            return SimpleNamespace(body={"date": "20261024090100", "open_pric": "-71500", "pre": "-500", "cntr_str": "99.25"})
        return SimpleNamespace(body={})

    monkeypatch.setattr(gateway, "_fetch_page", page)
    raw = analysis.get_feature("kr_minute_quote_raw", {}, instrument=_instrument())
    missing = analysis.get_feature("kr_price_profile_raw", {}, instrument=_instrument())

    assert calls[0] == ("ka10006", "/api/dostk/mrkcond", {"stk_cd": "005930"}, {})
    assert raw["rows"] == [{
        "id": "kr_minute_quote_raw:provider", "date": "20261024090100", "open_pric": "-71500", "high_pric": None,
        "low_pric": None, "close_pric": None, "pre": "-500", "flu_rt": None, "trde_qty": None,
        "trde_prica": None, "cntr_str": "99.25", "instrument": _instrument(),
    }]
    assert all(column["numeric"] is False for column in raw["columns"])
    assert missing["status"] == "error"
    assert missing["complete"] is False


def test_program_daily_trend_exposes_only_verified_krx_nxt_codes():
    market_code = next(parameter for parameter in analysis.FEATURES["kr_program_daily_trend"]["parameters"] if parameter["key"] == "marketCode")
    assert [option["value"] for option in market_code["options"]] == ["P00101", "P001_NX01", "P10102", "P101_NX02"]


def test_strength_schemas_match_the_exact_documented_intraday_and_daily_fields():
    expected_common_sources = [
        "cur_prc", "pred_pre", "pred_pre_sig", "flu_rt", "trde_qty", "acc_trde_prica",
        "acc_trde_qty", "cntr_str", "cntr_str_5min", "cntr_str_20min", "cntr_str_60min",
    ]
    expected_common_keys = [
        "price", "change", "changeSign", "changePct", "volume", "accumulatedValue",
        "accumulatedVolume", "strength", "strength5", "strength20", "strength60",
    ]

    assert [field[1] for field in analysis._STRENGTH_INTRADAY_FIELDS] == ["cntr_tm", *expected_common_sources]
    assert [field[0] for field in analysis._STRENGTH_INTRADAY_FIELDS] == ["time", *expected_common_keys]
    assert [field[1] for field in analysis._STRENGTH_DAILY_FIELDS] == ["dt", *expected_common_sources]
    assert [field[0] for field in analysis._STRENGTH_DAILY_FIELDS] == ["date", *expected_common_keys]
    assert all(field[1] != "stex_tp" for field in analysis._STRENGTH_INTRADAY_FIELDS)
    assert all(field[1] != "stex_tp" for field in analysis._STRENGTH_DAILY_FIELDS)
    assert [column["key"] for column in analysis._SPECS["kr_strength_intraday"]["columns"]] == ["time", *expected_common_keys]
    assert [column["key"] for column in analysis._SPECS["kr_strength_daily"]["columns"]] == ["date", *expected_common_keys]
