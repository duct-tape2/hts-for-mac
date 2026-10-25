from __future__ import annotations

import pytest

from app import analysis_us as analysis
from app import kiwoom_gateway as gateway


@pytest.fixture(autouse=True)
def clear_cache():
    analysis._clear_caches_for_tests()


def _instrument(code: str = "NVDA", venue: str = "ND") -> dict:
    return {
        "market": "US", "stkCd": code, "stkNm": "NVIDIA", "stexTp": venue,
        "listingVenue": "NASDAQ", "quoteVenue": venue, "currency": "USD", "environment": "real",
    }


@pytest.mark.parametrize(
    ("feature_id", "params", "api_id", "path", "body"),
    [
        ("usa20150", {"symbol": "NVDA", "exchange": "ND"}, "usa20150", "/api/us/mrkcond", {"stex_tp": "ND", "stk_cd": "NVDA"}),
        ("usa20151", {"symbol": "NVDA", "exchange": "ND", "baseDate": "2026-10-24"}, "usa20151", "/api/us/mrkcond", {"stex_tp": "ND", "stk_cd": "NVDA", "base_dt": "20261024"}),
        ("usa01980", {"interval": "10m"}, "usa01980", "/api/us/rkinfo", {"svc_type": "B282"}),
        ("usa01990", {"period": "week", "product": "etf"}, "usa01990", "/api/us/rkinfo", {"dt_unit_tp": "W", "stk_tp": "E"}),
        ("usa20510", {}, "usa20510", "/api/us/rkinfo", {"stex_tp": "0", "inds_cd": "", "stk_tp": "0", "trde_qty_tp": "0", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0", "tm": "1"}),
        ("usa20530", {}, "usa20530", "/api/us/rkinfo", {"stex_tp": "0", "inds_cd": "", "stk_tp": "0", "trde_qty_tp": "0", "qry_tp": "0", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0"}),
        ("usa20540", {}, "usa20540", "/api/us/rkinfo", {"stex_tp": "0", "inds_cd": "", "stk_tp": "0", "trde_qty_tp": "0", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0"}),
        ("usa20550", {}, "usa20550", "/api/us/rkinfo", {"stex_tp": "0", "inds_cd": "", "stk_tp": "0", "trde_qty_tp": "0", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0"}),
        ("usa23000", {}, "usa23000", "/api/us/sect", {"stex_tp": "0", "inds_cd": "0"}),
        ("usa23100", {}, "usa23100", "/api/us/sect", {"stex_tp": "0", "sort_tp": "1", "inds_cd": "000"}),
        ("usa20520", {}, "usa20520", "/api/us/stkinfo", {"stex_tp": "0", "inds_cd": "", "tm": "5", "stk_tp": "0", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0", "trde_qty_tp": "0"}),
        ("usa24100", {}, "usa24100", "/api/us/stkinfo", {"stex_tp": "0", "stk_tp": "0", "inds_cd": "", "stk_cnd": "0", "ntl_tp": "1", "high_low_tp": "1", "dt": "", "pric_cnd": "0", "trde_qty_tp": "0", "trde_prica_cnd": "0"}),
        ("usa24140", {}, "usa24140", "/api/us/stkinfo", {"stex_tp": "0", "inds_cd": "", "stk_tp": "0", "sort_tp": "1", "updown_tp": "1", "alacc_rt": "3", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0", "trde_qty_tp": "0"}),
        ("usa20930", {}, "usa20930", "/api/us/stkinfo", {"stex_tp": "0", "stk_tp": "0", "inds_cd": "", "stk_cnd": "0", "flu_tp": "1", "tm_tp": "1", "tm": "0", "pric_cnd": "0", "trde_qty_tp": "0", "trde_prica_cnd": "0"}),
        ("usa24200", {}, "usa24200", "/api/us/rkinfo", {"stex_tp": "0", "inds_cd": "", "stk_tp": "0", "sort_tp": "1", "stk_cnd": "0", "trde_qty_tp": "0", "pric_cnd": "0", "trde_prica_cnd": "0"}),
        ("usa24300", {}, "usa24300", "/api/us/invtinfo", {"qry_tp": "0"}),
        ("usa20880", {}, "usa20880", "/api/us/rkinfo", {"qry_tp": "1", "dt_unit_tp": "1"}),
        ("usa20881", {"rankType": "tradeValue", "period": "5m"}, "usa20881", "/api/us/rkinfo", {"qry_tp": "7", "dt_unit_tp": "8"}),
        ("usa20910", {}, "usa20910", "/api/us/rkinfo", {"stex_tp": "0", "inds_cd": "", "inds_cls_tp": "0", "sort_tp": "1", "stk_tp": "0", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0", "trde_qty_tp": "0"}),
        ("usa20911", {}, "usa20911", "/api/us/rkinfo", {"stex_tp": "0", "etf_cat1": "", "etf_cat2": "", "sort_tp": "1", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0", "trde_qty_tp": "0"}),
        ("usa20920", {}, "usa20920", "/api/us/rkinfo", {"stex_tp": "0", "inds_cd": "", "trde_qty_tp": "0", "stk_tp": "0", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0", "sort_tp": "1"}),
        ("usa20921", {}, "usa20921", "/api/us/rkinfo", {"stex_tp": "0", "etf_cat1": "", "etf_cat2": "", "trde_qty_tp": "0", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0", "sort_tp": "1"}),
        # This is the installed official SDK's usa20922 request example, kept
        # verbatim in canonical JSON-string form to guard the nested list
        # encoding, venue values, and default sort/filter enums.
        ("usa20922", {"symbols": "NY:BA, ND:AMGN"}, "usa20922", "/api/us/rkinfo", {"stex_tp": "0", "stk_cd": '[{"stex_tp":"NY","stk_cd":"BA"},{"stex_tp":"ND","stk_cd":"AMGN"}]', "sort_tp": "1", "stk_tp": "0", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0", "trde_qty_tp": "0"}),
        ("usa20940", {"baseDate": "2026-04-10"}, "usa20940", "/api/us/rkinfo", {"stex_tp": "0", "inds_cd": "", "stk_tp": "0", "sort_tp": "0", "pric_cnd1": "-100", "pric_cnd2": "100", "base_dt": "20260410", "stk_cnd": "0", "trde_qty_tp": "0", "pric_cnd": "0", "trde_prica_cnd": "0"}),
        ("usa20941", {"baseDate": "2026-04-10"}, "usa20941", "/api/us/rkinfo", {"stex_tp": "0", "etf_cat1": "", "etf_cat2": "", "sort_tp": "0", "pric_cnd1": "-100", "pric_cnd2": "100", "base_dt": "20260410", "stk_cnd": "0", "trde_qty_tp": "0", "pric_cnd": "0", "trde_prica_cnd": "0"}),
        ("usa20960", {}, "usa20960", "/api/us/rkinfo", {"stex_tp": "0", "inds_cd": "", "stk_tp": "0", "qry_tp": "0"}),
        ("usa20961", {"rankBy": "value"}, "usa20961", "/api/us/rkinfo", {"stex_tp": "0", "etf_cat1": "", "etf_cat2": "", "qry_tp": "1"}),
        ("usa26410", {"symbol": "NVDA", "exchange": "ND"}, "usa26410", "/api/us/stkinfo", {"stex_tp": "ND", "stk_cd": "NVDA"}),
        ("usa26411", {"searchYear": "2025"}, "usa26411", "/api/us/stkinfo", {"inds_cd": "000", "srch_yr": "2025"}),
        ("usa26412", {"searchYear": "2025"}, "usa26412", "/api/us/stkinfo", {"etf_cat1": "", "etf_cat2": "", "srch_yr": "2025"}),
        ("usa26413", {}, "usa26413", "/api/us/stkinfo", {"inds_cd": "000"}),
        ("usa26414", {}, "usa26414", "/api/us/stkinfo", {"etf_cat1": "", "etf_cat2": ""}),
    ],
)
def test_each_feature_uses_only_its_documented_contract(monkeypatch, feature_id, params, api_id, path, body):
    calls: list[tuple] = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)

    def fetch(actual_api, actual_path, actual_body, list_key, *, max_pages):
        calls.append((actual_api, actual_path, actual_body, list_key, max_pages))
        return analysis._FIXTURE_ROWS[feature_id], True, ""

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    result = analysis.get_feature(feature_id, params)

    assert calls == [(api_id, path, body, "result_list", 5)]
    assert result["featureId"] == feature_id
    assert result["source"] == "kiwoom" and result["status"] == "snapshot"
    assert result["asOf"] is None and result["complete"] is True
    assert set(column["key"] for column in result["columns"]) <= result["rows"][0].keys()
    assert all("numeric" in column for column in result["columns"])
    if feature_id in {"usa20880", "usa20881", "usa20910", "usa20911", "usa20920", "usa20921", "usa20922", "usa20940", "usa20941", "usa20960", "usa20961", "usa26410", "usa26411", "usa26412"}:
        identity = result["rows"][0]["instrument"]
        assert identity["market"] == "US" and identity["currency"] == "USD" and identity["stkNm"]


def test_public_metadata_and_allow_list_cover_only_the_approved_pairs():
    expected_ids = {"usa20150", "usa20151", "usa01980", "usa01990", "usa20510", "usa20520", "usa20530", "usa20540", "usa20550", "usa20930", "usa23000", "usa23100", "usa24100", "usa24140", "usa24200", "usa24300", "usa20880", "usa20881", "usa20910", "usa20911", "usa20920", "usa20921", "usa20922", "usa20940", "usa20941", "usa20960", "usa20961", "usa26410", "usa26411", "usa26412", "usa26413", "usa26414"}

    assert set(analysis.FEATURES) == expected_ids
    assert analysis.ALLOWED_CALLS == frozenset((feature["apiId"], feature["path"]) for feature in analysis.FEATURES.values())
    assert all(feature["market"] == "US" and {"title", "description", "parameters", "apiId", "path"} <= feature.keys() for feature in analysis.FEATURES.values())
    assert all(
        {"key", "label", "type", "default"} <= parameter.keys()
        and parameter["type"] in {"select", "date", "text", "number"}
        for feature in analysis.FEATURES.values() for parameter in feature["parameters"]
    )


def test_numeric_exchange_enums_are_feature_group_specific(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda _api, _path, body, _key, *, max_pages: (calls.append(body.copy()) or ([], True, "")))

    analysis.get_feature("usa20530", {"exchange": "nasdaq"})
    analysis.get_feature("usa23000", {"exchange": "nasdaq"})
    analysis.get_feature("usa23100", {"exchange": "amex", "direction": "losers"})

    assert calls == [
        {"stex_tp": "2", "inds_cd": "", "stk_tp": "0", "trde_qty_tp": "0", "qry_tp": "0", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0"},
        {"stex_tp": "3", "inds_cd": "0"},
        {"stex_tp": "2", "sort_tp": "2", "inds_cd": "000"},
    ]


def test_null_and_signed_provider_values_are_normalised_without_reversing_meaning(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(
        gateway,
        "_fetch_rows",
        lambda *_args, **_kwargs: ([{
            "rank": "1", "stex_tp": "ND", "stk_cd": "ADTX", "stk_nm": "Example",
            "cur_prc": "-0.0412", "pred_pre": "-0.0005", "flu_rt": "-1.20",
            "acc_trde_qty": "", "pred_rt": "Infinity", "trde_prica": "0",
        }], True, ""),
    )

    row = analysis.get_feature("usa20530", {})["rows"][0]

    assert row["price"] == 0.0412
    assert row["change"] == -0.0005 and row["changePct"] == -1.2
    assert row["volume"] is None and row["previousVolumePct"] is None
    assert row["tradingValue"] == 0.0


def test_query_rank_sign_codes_are_applied_and_raw_venue_is_not_sent_as_request_enum(monkeypatch):
    calls = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(
        gateway,
        "_fetch_rows",
        lambda api, path, body, key, *, max_pages: (calls.append((api, path, body, key, max_pages)) or ([{
            "rank": "02", "stk_cd": "MU", "stk_nm": "Micron", "stex_tp": "ND", "curr_pric": "109.7200",
            "sign": "+", "chg_val": "3", "sign_for_gjga": "-", "diff_rate_for_gjga": "4.32",
            "sign_for_prev": "+", "diff_rate_for_prev": "0.13",
        }], True, "")),
    )

    row = analysis.get_feature("usa01980", {"interval": "1m"})["rows"][0]

    assert calls == [("usa01980", "/api/us/rkinfo", {"svc_type": "B281"}, "result_list", 5)]
    assert row["exchange"] == "ND" and row["rankChange"] == 3.0
    assert row["referenceChangePct"] == -4.32 and row["previousChangePct"] == 0.13


def test_partial_pagination_is_visible_and_cached_snapshot_reuses_one_bounded_read(monkeypatch):
    calls = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *args, **kwargs: (calls.append((args, kwargs)) or (analysis._FIXTURE_ROWS["usa20540"], False, "continuation key missing")))

    first = analysis.get_feature("usa20540", {})
    second = analysis.get_feature("usa20540", {})

    assert len(calls) == 1
    assert first["complete"] is False and "continuation key missing" in first["note"]
    assert second == first


def test_live_failure_never_becomes_fixture_and_fixture_mode_never_reads_transport(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(gateway.BrokerError("provider text")))

    failed = analysis.get_feature("usa20550", {})

    assert failed["source"] == "kiwoom" and failed["status"] == "error" and failed["rows"] == []
    assert "키움 조회를 완료하지 못했습니다" in failed["note"]

    analysis._clear_caches_for_tests()
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", False)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: pytest.fail("fixture must not read transport"))
    fixture = analysis.get_feature("usa20550", {})
    assert fixture["source"] == fixture["status"] == "fixture"


def test_disabled_non_fixture_environment_returns_explicit_error_not_fixture(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", False)
    monkeypatch.setattr(analysis, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: pytest.fail("disabled non-fixture must not read transport"))

    result = analysis.get_feature("usa20550", {})

    assert result["source"] == "kiwoom" and result["status"] == "error" and result["rows"] == []
    assert result["note"] == "Kiwoom read is disabled outside fixture mode."


def test_invalid_inputs_fail_before_transport_and_instrument_is_only_attached_on_exact_match(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("transport")))

    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa20530", {"exchange": "ND"})
    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa20530", {"unknown": "x"})
    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa20150", {"symbol": "NVDA", "exchange": "NY"}, instrument=_instrument())

    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: ([{"cur_prc": "+100", "pred_pre": "+1", "flu_rt": "+1", "trde_qty": "+2", "cntr_tm": "093000", "pred_pre_sig": "2", "stk_cd": "NVDA", "stex_tp": "ND"}], True, ""))
    result = analysis.get_feature("usa20150", {"symbol": "NVDA", "exchange": "ND"}, instrument=_instrument())
    expected = _instrument()
    expected["environment"] = analysis.ENVIRONMENT
    assert result["rows"][0]["instrument"] == expected


def test_rank_rows_build_independent_parser_compatible_us_identities(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(analysis, "ENVIRONMENT", "demo")
    monkeypatch.setattr(
        gateway,
        "_fetch_rows",
        lambda *_args, **_kwargs: ([{
            "rank": "2", "stex_tp": "NY", "stk_cd": "AAPL", "stk_nm": "Apple Inc.",
            "cur_prc": "+200.0000", "pred_pre": "+1.0", "flu_rt": "+0.5", "acc_trde_qty": "100",
            "pred_rt": "+1", "trde_prica": "2000",
        }], True, ""),
    )

    result = analysis.get_feature("usa20530", {}, instrument=_instrument())
    identity = result["rows"][0]["instrument"]

    assert identity == {
        "market": "US", "stkCd": "AAPL", "stkNm": "Apple Inc.", "stexTp": "NY",
        "listingVenue": "NYSE", "quoteVenue": "NY", "currency": "USD", "environment": "demo",
    }
    assert isinstance(identity["stkNm"], str) and identity["stkNm"]


def test_calendar_date_tape_identity_mismatch_and_live_errors_are_safe(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("transport")))

    with pytest.raises(analysis.InputError, match="invalid baseDate"):
        analysis.get_feature("usa20151", {"symbol": "NVDA", "exchange": "ND", "baseDate": "2026-02-30"})

    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: ([{"stk_cd": "AAPL", "stex_tp": "NY", "cur_prc": "+1"}], True, ""))
    mismatch = analysis.get_feature("usa20150", {"symbol": "NVDA", "exchange": "ND"})
    assert mismatch["status"] == "error" and mismatch["rows"] == []

    analysis._clear_caches_for_tests()
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(gateway.BrokerError("super-secret-token")))
    failed = analysis.get_feature("usa20520", {})
    assert "super-secret-token" not in str(failed)


def test_cache_key_uses_adapter_environment(monkeypatch):
    calls = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (calls.append(True) or (analysis._FIXTURE_ROWS["usa24300"], True, "")))

    analysis.get_feature("usa24300", {})
    monkeypatch.setattr(analysis, "ENVIRONMENT", "demo")
    analysis.get_feature("usa24300", {})

    assert len(calls) == 2


def test_tape_uses_request_identity_name_fallback_and_book_ratios_use_documented_hundredths(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    calls = []

    def fetch(api_id, _path, _body, _key, *, max_pages):
        calls.append((api_id, max_pages))
        if api_id == "usa20150":
            # The official tape row schema intentionally has no code/venue.
            return ([{"cur_prc": "+100", "pred_pre": "+1", "flu_rt": "+1", "trde_qty": "+2", "cntr_tm": "093000", "pred_pre_sig": "2"}], True, "")
        return ([{
            "rank": "1", "stex_tp": "NY", "stk_cd": "PRA", "stk_nm": "Provider Name", "cur_prc": "+24.99", "pred_pre": "+0.34",
            "acc_trde_qty": "10", "tot_sel_req": "20", "tot_buy_req": "30", "buy_req": "10", "buy_rt": "2658", "sel_req": "-10", "sel_rt": "81", "cntr_tm": "08:02",
        }], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    tape = analysis.get_feature("usa20150", {"symbol": "NVDA", "exchange": "ND"})
    book = analysis.get_feature("usa24200", {})

    assert tape["rows"][0]["instrument"]["stkNm"] == "NVDA"
    assert book["rows"][0]["netBuyRatio"] == 26.58
    assert book["rows"][0]["netSellRatio"] == 0.81
    assert calls == [("usa20150", 5), ("usa24200", 5)]


def test_added_scan_enum_bounds_are_rejected_before_transport(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("transport")))

    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa24100", {"periodDays": "251"})
    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa20930", {"comparisonType": "minutes", "comparison": "31"})
    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa20930", {"comparisonType": "period", "comparison": "0"})
    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa24140", {"minimumGap": "4"})


def test_u05_uses_its_two_distinct_exchange_enum_families_and_customer_scope(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda _api, _path, body, _key, *, max_pages: (calls.append(body.copy()) or (analysis._FIXTURE_ROWS["usa20880"], True, "")))

    customer = analysis.get_feature("usa20880", {"rankType": "tradeValue", "period": "5m"})
    analysis.get_feature("usa20910", {"exchange": "nasdaq", "sort": "fallAmount"})
    analysis.get_feature("usa20940", {"exchange": "nasdaq", "baseDate": "2026-04-10"})

    assert calls[0] == {"qry_tp": "7", "dt_unit_tp": "8"}
    assert calls[1]["stex_tp"] == "2" and calls[1]["sort_tp"] == "5"
    assert calls[2]["stex_tp"] == "3" and calls[2]["sort_tp"] == "0"
    assert customer["scope"]["population"] == "Kiwoom customer activity sample; not a whole-market ranking."
    assert customer["scope"]["periodScope"] == {"aggregation": "5m"}
    assert analysis.get_feature("usa20910", {"exchange": "nasdaq", "sort": "fallAmount"})["scope"]["marketScope"] == {"exchange": "nasdaq", "providerRequestExchange": "2"}


def test_u05_rows_preserve_documented_units_signs_and_independent_identity(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)

    def fetch(api_id, _path, _body, _key, *, max_pages):
        if api_id == "usa20910":
            return ([{
                "rank": "1", "stex_tp": "NY", "stk_cd": "AAPL", "stk_nm": "Fixture Apple",
                "cur_prc": "-220.1200", "pred_pre": "-0.50", "flu_rt": "-0.23",
                "sel_req": "+7", "buy_req": "-3", "trde_qty": "-10", "cnt": "2",
            }], True, "")
        if api_id == "usa20940":
            return ([{
                "rank": "1", "stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA",
                "cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59", "acc_trde_qty": "123",
                "hgst_pric": "200", "stk_high_dt": "20261020", "lwst_pric": "150", "stk_low_dt": "20260115",
                "acc_flu_rt": "-12.34", "acc_flu_amt": "-22.00",
            }], True, "")
        return ([{"dt": "0", "m01_prft_rt": "-1.25", "m02_prft_rt": "+2.50"}], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    daily = analysis.get_feature("usa20910", {})
    cumulative = analysis.get_feature("usa20940", {"baseDate": "2026-04-10"})
    yearly = analysis.get_feature("usa26413", {})

    assert daily["rows"][0]["tradeQuantity"] == -10 and daily["rows"][0]["instrument"]["stkCd"] == "AAPL"
    assert {column["key"]: column.get("unit") for column in daily["columns"]}["tradeQuantity"] == "shares"
    assert cumulative["rows"][0]["cumulativeChangePct"] == -12.34 and cumulative["rows"][0]["cumulativeChange"] == -22.0
    assert {column["key"]: column.get("unit") for column in cumulative["columns"]}["cumulativeChangePct"] == "%"
    assert yearly["rows"][0]["yearKind"] == "average" and yearly["rows"][0]["janReturn"] == -1.25
    assert all("unit" not in column for column in yearly["columns"] if column["key"].endswith("Return"))


def test_u05_watchlist_and_period_inputs_are_strict_before_transport(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("transport")))

    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa20922", {"symbols": "[]"})
    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa20922", {"symbols": '[{"stex_tp":"ND","stk_cd":"bad-symbol"}]'})
    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa20922", {"symbols": "ND:AAPL, ZZ:IBM"})
    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa20940", {"baseDate": "2026-02-30"})
    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa20941", {"minimumCumulativePct": "2", "maximumCumulativePct": "1"})
    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa26411", {"searchYear": "26"})
    with pytest.raises(analysis.InputError):
        analysis.get_feature("usa20880", {"rankType": "tradeValue", "period": "day"})


def test_u05_watchlist_simple_input_is_deduplicated_to_canonical_broker_json(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(
        gateway,
        "_fetch_rows",
        lambda _api, _path, body, _key, *, max_pages: (calls.append(body.copy()) or (analysis._FIXTURE_ROWS["usa20922"], True, "")),
    )

    result = analysis.get_feature("usa20922", {"symbols": "ND:AAPL, NY:IBM, ND:AAPL"})
    symbols = next(parameter for parameter in analysis.FEATURES["usa20922"]["parameters"] if parameter["key"] == "symbols")

    assert calls[0]["stk_cd"] == '[{"stex_tp":"ND","stk_cd":"AAPL"},{"stex_tp":"NY","stk_cd":"IBM"}]'
    assert result["parameters"]["symbols"] == calls[0]["stk_cd"]
    assert symbols == {"key": "symbols", "label": "관심 종목 (ND:AAPL, NY:IBM)", "type": "text", "default": "", "maxLength": 2048}


@pytest.mark.parametrize(
    ("feature_id", "expected_units"),
    [
        ("usa20880", {"price": "USD", "changePct": "%"}),
        ("usa20881", {"price": "USD", "changePct": "%"}),
        ("usa20910", {"askQuantity": "shares", "bidQuantity": "shares", "tradeQuantity": "shares"}),
        ("usa20911", {"askQuantity": "shares", "bidQuantity": "shares", "tradeQuantity": "shares"}),
        ("usa20920", {"high": "USD", "openChangePct": "%", "volume": "shares"}),
        ("usa20921", {"high": "USD", "openChangePct": "%", "volume": "shares"}),
        ("usa20922", {"high": "USD", "openChangePct": "%", "volume": "shares"}),
        ("usa20940", {"highestPrice": "USD", "cumulativeChangePct": "%", "cumulativeChange": "USD"}),
        ("usa20941", {"highestPrice": "USD", "cumulativeChangePct": "%", "cumulativeChange": "USD"}),
        ("usa20960", {"previousTradeRate": "%", "volume": "shares"}),
        ("usa20961", {"previousTradeRate": "%", "volume": "shares"}),
        ("usa26410", {"janReturn": None, "decReturn": None}),
        ("usa26411", {"janReturn": None, "decReturn": None}),
        ("usa26412", {"janReturn": None, "decReturn": None}),
        ("usa26413", {"janReturn": None, "decReturn": None}),
        ("usa26414", {"janReturn": None, "decReturn": None}),
    ],
)
def test_u05_column_units_match_documented_or_unknown_metadata(feature_id, expected_units):
    units = {column["key"]: column.get("unit") for column in analysis._feature_columns(feature_id)}
    assert {key: units[key] for key in expected_units} == expected_units
