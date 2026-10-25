from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import capture_market as capture
from app import kiwoom_gateway as gateway


@pytest.fixture(autouse=True)
def clear_capture_cache():
    capture._clear_caches_for_tests()


def test_fixture_screens_are_labelled_and_do_not_send_upstream(monkeypatch):
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_a, **_kw: (_ for _ in ()).throw(AssertionError("broker")))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_a, **_kw: (_ for _ in ()).throw(AssertionError("broker")))
    for code in ("0198", "0184", "0186", "0162", "0187", "0211", "0602", "0780", "2797", "0200", "0700"):
        result = capture.capture_screen(code)
        assert result["environment"] == "fixture"
        assert result["status"] == "fixture"
        assert isinstance(result["columns"], list) and isinstance(result["rows"], list)
        assert all(set(column["key"] for column in result["columns"]) <= row.keys() for row in result["rows"])
        assert set(result["scope"]) == {"appliedFilters", "effectiveStart", "effectiveEnd", "returnedRows", "limitedReason", "unsupported"}
    cap = capture.capture_screen("0187")
    assert cap["rows"][0]["tradingWeight"] is None
    assert cap["scope"]["unsupported"] == ["tradingWeight"]
    assert "산식이 확인되지 않아 표시하지 않습니다" in cap["note"]


def test_invalid_query_and_unknown_screen_are_rejected_before_index_or_transport(monkeypatch):
    monkeypatch.setattr(gateway, "_indexed", lambda *_a: (_ for _ in ()).throw(AssertionError("index")))
    monkeypatch.setattr(gateway, "_fetch_page", lambda *_a, **_kw: (_ for _ in ()).throw(AssertionError("page")))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_a, **_kw: (_ for _ in ()).throw(AssertionError("rows")))
    with pytest.raises(capture.InputError):
        capture.capture_screen("0184", venue="bad")
    with pytest.raises(capture.InputError):
        capture.capture_screen("9999")
    with pytest.raises(capture.InputError):
        capture.capture_screen("0700", query="x" * 101)


def test_0184_uses_official_sort_and_preserves_source_units(monkeypatch):
    calls = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_indexed", lambda *_a: ([], True, ""))

    def fetch(api, path, body, key, *, max_pages):
        calls.append((api, path, body, key, max_pages))
        return ([{"stk_cd": "005930", "stk_nm": "삼성전자", "cur_prc": "-71500", "pred_pre": "+500", "flu_rt": "+0.70", "trde_qty": "1200000", "pred_rt": "+1.2", "trde_tern_rt": "2.35", "trde_amt": "85800"}], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    result = capture.capture_screen("0184", sort="value", venue="ALL")
    assert calls == [("ka10030", "/api/dostk/rkinfo", {"mrkt_tp": "000", "sort_tp": "3", "mang_stk_incls": "0", "crd_tp": "0", "trde_qty_tp": "0", "pric_tp": "0", "trde_prica_tp": "0", "mrkt_open_tp": "0", "stex_tp": "3"}, "tdy_trde_qty_upper", 5)]
    row = result["rows"][0]
    assert row["price"] == 71500.0 and row["change"] == 500.0
    assert row["turnoverRate"] == 2.35 and row["tradingValue"] == 85800.0
    assert next(column for column in result["columns"] if column["key"] == "tradingValue")["unit"] == "KRW millions"


def test_0184_sends_only_documented_session_and_rank_conditions(monkeypatch):
    calls = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_indexed", lambda *_a: ([], True, ""))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda api, path, body, key, *, max_pages: (calls.append((api, path, body, key, max_pages)) or ([], True, "")))

    result = capture.capture_screen("0184", market="KOSDAQ", venue="NXT", sort="turnover", session="afterMarket", stock="excludeEtf", credit="loan", volumeBand="100k", priceBand="over10k", valueBand="1b")

    assert calls == [("ka10030", "/api/dostk/rkinfo", {"mrkt_tp": "101", "sort_tp": "2", "mang_stk_incls": "14", "crd_tp": "8", "trde_qty_tp": "100", "pric_tp": "7", "trde_prica_tp": "100", "mrkt_open_tp": "3", "stex_tp": "2"}, "tdy_trde_qty_upper", 5)]
    assert result["scope"]["appliedFilters"] == {"market": "KOSDAQ", "venue": "NXT", "sort": "turnover", "session": "afterMarket", "stock": "excludeEtf", "credit": "loan", "volumeBand": "100k", "priceBand": "over10k", "valueBand": "1b"}


def test_0162_sends_documented_sort_conditions_and_previous_limit_direction(monkeypatch):
    calls = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_indexed", lambda *_a: ([], True, ""))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda api, path, body, key, *, max_pages: (calls.append((api, path, body, key, max_pages)) or ([], True, "")))

    result = capture.capture_screen("0162", market="KOSPI", venue="KRX", direction="previousUpLimit", limitSort="streak", stock="excludeManagedPreferred", credit="creditE", volumeBand="150k", priceBand="2to3k")

    assert calls == [("ka10017", "/api/dostk/stkinfo", {"mrkt_tp": "001", "updown_tp": "6", "sort_tp": "2", "stk_cnd": "4", "trde_qty_tp": "00150", "crd_cnd": "7", "trde_gold_tp": "3", "stex_tp": "1"}, "updown_pric", 5)]
    assert result["scope"]["appliedFilters"]["direction"] == "previousUpLimit"


def test_0186_only_adds_documented_managed_inclusion(monkeypatch):
    calls = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_indexed", lambda *_a: ([], True, ""))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda api, path, body, key, *, max_pages: (calls.append((api, path, body, key, max_pages)) or ([], True, "")))

    capture.capture_screen("0186", market="KOSPI", venue="NXT", managed="include")

    assert calls == [("ka10032", "/api/dostk/rkinfo", {"mrkt_tp": "001", "mang_stk_incls": "1", "stex_tp": "2"}, "trde_prica_upper", 5)]
    with pytest.raises(capture.InputError):
        capture.capture_screen("0186", valueBand="1b")
    with pytest.raises(capture.InputError):
        capture.capture_screen("0162", stock="excludeEtf")


def test_rank_selection_metadata_signals_cold_index_then_recovers(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    ready = {**capture._FIXTURE_INSTRUMENTS["005930"], "environment": "real"}
    index = {"rows": []}
    monkeypatch.setattr(gateway, "_indexed", lambda *_a: (index["rows"], bool(index["rows"]), "loading" if not index["rows"] else ""))
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_a, **_kw: ([{"stk_cd": "005930", "stk_nm": "삼성전자", "cur_prc": "71500", "pred_pre": "+500", "flu_rt": "+0.7", "trde_qty": "1200000", "pred_rank": "1", "sel_bid": "71510", "buy_bid": "71500", "pred_trde_qty": "1100000", "trde_prica": "85800"}], True, ""))

    cold = capture.capture_screen("0186")
    assert cold["selectionPending"] is True
    assert "instrument" not in cold["rows"][0]

    index["rows"] = [ready]
    hydrated = capture.capture_screen("0186")
    assert "selectionPending" not in hydrated
    assert hydrated["rows"][0]["instrument"] == ready


def test_0187_coalesces_per_query_and_bounds_serial_collection_cache(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(capture, "_CAP_MAX_STATES", 2)
    instruments = {
        "000001": {"market": "KR", "stkCd": "000001", "stkNm": "코스피", "stexTp": "KRX", "listingVenue": "KOSPI", "quoteVenue": "KRX", "currency": "KRW", "environment": "real"},
        "000002": {"market": "KR", "stkCd": "000002", "stkNm": "코스닥", "stexTp": "KRX", "listingVenue": "KOSDAQ", "quoteVenue": "KRX", "currency": "KRW", "environment": "real"},
    }
    monkeypatch.setattr(capture, "_instruments", lambda: dict(instruments))

    def fetch(_api, _path, body, _key, *, max_pages):
        code = body["stk_cd"].split("|")[0]
        return ([{"stk_cd": code, "stk_nm": code, "cur_prc": "100", "pred_pre": "+1", "flu_rt": "+1", "trde_qty": "1", "mac": "1000", "cntr_str": "100"}], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    started = []

    class DeferredThread:
        def __init__(self, *, target, name, daemon):
            self.target, self.name, self.daemon = target, name, daemon

        def start(self):
            started.append(self)

    monkeypatch.setattr(capture, "Thread", DeferredThread)
    capture.capture_screen("0187", market="KOSPI", venue="ALL")
    capture.capture_screen("0187", market="KOSDAQ", venue="ALL")
    capture.capture_screen("0187", market="KOSPI", venue="ALL")  # same key coalesces
    assert len(started) == 1
    assert len(capture._CAPS) == len(capture._CAP_QUEUE) == 2

    capture._run_cap_queue()
    assert all(state["done"] and not state["running"] for state in capture._CAPS.values())
    assert capture.capture_screen("0187", market="KOSPI", venue="ALL")["rows"][0]["id"] == "000001_AL"
    assert capture.capture_screen("0187", market="KOSDAQ", venue="ALL")["rows"][0]["id"] == "000002_AL"

    capture.capture_screen("0187", market="KOSPI", venue="KRX")
    assert len(capture._CAPS) == 2  # only an idle completed state was evicted
    assert len(capture._CAP_QUEUE) == 1
    assert len(started) == 2


def test_0187_scheduler_restarts_for_a_query_arriving_during_empty_handoff(monkeypatch):
    started = []

    class DeferredThread:
        def __init__(self, *, target, name, daemon):
            self.target, self.name, self.daemon = target, name, daemon

        def start(self):
            started.append(self)

    handoff_key = ("handoff",)

    class InjectingWorkerLock:
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            # This executes after the worker saw an empty queue but before its
            # finally block clears the scheduler-running flag.
            with capture._CAP_LOCK:
                capture._CAPS[handoff_key] = {"running": True}
                capture._CAP_QUEUE.append((handoff_key, "real", [], {}))

    monkeypatch.setattr(capture, "Thread", DeferredThread)
    monkeypatch.setattr(capture, "_CAP_WORKER_LOCK", InjectingWorkerLock())
    with capture._CAP_LOCK:
        capture._CAP_SCHEDULER_RUNNING = True
    capture._run_cap_queue()
    assert len(started) == 1
    assert capture._CAP_SCHEDULER_RUNNING is True
    assert len(capture._CAP_QUEUE) == 1


def test_0187_keeps_exact_query_snapshot_during_expired_refresh_and_failure(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    instruments = {
        "000001": {"market": "KR", "stkCd": "000001", "stkNm": "코스피", "stexTp": "KRX", "listingVenue": "KOSPI", "quoteVenue": "KRX", "currency": "KRW", "environment": "real"},
        "000002": {"market": "KR", "stkCd": "000002", "stkNm": "코스닥", "stexTp": "KRX", "listingVenue": "KOSDAQ", "quoteVenue": "KRX", "currency": "KRW", "environment": "real"},
    }
    monkeypatch.setattr(capture, "_instruments", lambda: dict(instruments))
    mode = {"cap": 2000, "fail": False}

    def fetch(_api, _path, body, _key, *, max_pages):
        if mode["fail"]: raise gateway.BrokerError("fixture failure")
        code = body["stk_cd"].split("|")[0]
        return ([{"stk_cd": code, "stk_nm": code, "cur_prc": "100", "pred_pre": "+1", "flu_rt": "+1", "trde_qty": "1", "mac": str(mode["cap"]), "cntr_str": "100"}], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    monkeypatch.setattr(capture, "Thread", type("DeferredThread", (), {"__init__": lambda self, **_kw: None, "start": lambda self: None}))
    key = ("real", "ALL", ("000001",))
    state = capture._cap_state(key, "real", 1, 1)
    state.update({"snapshot_rows": {"000001_AL": {"id": "000001_AL", "name": "이전", "marketCap": 1000.0}}, "snapshot_complete": True, "snapshot_received_at": "2026-10-25T12:23:20Z", "running": False, "done": True, "finished": 0.0})
    capture._CAPS[key] = state

    stale = capture.capture_screen("0187", market="KOSPI")
    assert stale["status"] == "delayed" and stale["complete"] is False and stale["rows"][0]["marketCap"] == 1000.0
    assert stale["receivedAt"] == "2026-10-25T12:23:20Z" and stale["asOf"] is None and "이전 완료 자료 · 수집 완료 2026-10-25T12:23:20Z · 갱신 수집 0/1" in stale["note"]
    assert capture.capture_screen("0187", market="KOSDAQ")["rows"] == []

    capture._collect_caps(key, "real", ["000001_AL"], instruments)
    replaced = capture.capture_screen("0187", market="KOSPI")
    assert replaced["status"] == "snapshot" and replaced["complete"] is True and replaced["rows"][0]["marketCap"] == 2000.0
    clock = capture._CAPS[key]["snapshot_received_at"]
    with capture._CAP_LOCK: capture._CAPS[key].update({"running": True, "done": False, "queried": 0, "rows": {}, "note": ""})
    mode["fail"] = True
    capture._collect_caps(key, "real", ["000001_AL"], instruments)
    failed = capture.capture_screen("0187", market="KOSPI")
    assert failed["status"] == "delayed" and failed["complete"] is False and failed["rows"][0]["marketCap"] == 2000.0
    assert "이전 완료 자료" in failed["note"] and "갱신 실패" in failed["note"] and failed["receivedAt"] == clock


def test_0198_uses_period_not_chart_interval(monkeypatch):
    calls = []
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "_indexed", lambda *_a: ([], True, ""))

    def fetch(api, path, body, key, *, max_pages):
        calls.append((api, path, body, key))
        return ([{"stk_cd": "005930", "stk_nm": "삼성전자", "bigd_rank": "1", "past_curr_prc": "-71500", "base_comp_chgr": "0.7", "dt": "20261024", "tm": "090000"}], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    result = capture.capture_screen("0198", period="5")
    assert result["rows"][0]["rank"] == 1
    assert calls == [("ka00198", "/api/dostk/stkinfo", {"qry_tp": "5"}, "item_inq_rank")]
    assert result["scope"]["unsupported"] == ["etf"]
    with pytest.raises(capture.InputError):
        capture.capture_screen("0198", interval="30")


def test_industry_chart_scales_only_the_documented_ka20006_index(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_fetch_rows", lambda api, path, body, key, *, max_pages: ([{"dt": "20261024", "open_pric": "270123", "high_pric": "271000", "low_pric": "269000", "cur_prc": "270500", "trde_qty": "1234"}], True, "") if api == "ka20006" else (_ for _ in ()).throw(AssertionError(api)))
    result = capture.capture_screen("0602", sector="001", interval="D")
    assert result["bars"] == [{"t": "20261024", "o": 2701.23, "h": 2710.0, "l": 2690.0, "c": 2705.0, "v": 1234.0}]
    assert "divided by 100" in result["note"]


def test_investor_screen_uses_provider_overall_rows_without_sector_sum(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")

    def fetch(_api, _path, body, _key, *, max_pages):
        code = "001" if body["mrkt_tp"] == "0" else "101"
        return ([{"inds_cd": code, "inds_nm": "overall", "ind_netprps": "-10", "frgnr_netprps": "+20", "orgn_netprps": "+30"}, {"inds_cd": "999", "ind_netprps": "999999"}], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", fetch)
    result = capture.capture_screen("0780", market="all", start="20261024", unit="amount")
    assert [row["individual"] for row in result["rows"]] == [-10.0, -10.0]
    assert all(row["unit"] == "KRW 100m" for row in result["rows"])
    assert result["complete"] is True


def test_2797_refuses_unverified_period_before_transport(monkeypatch):
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_a, **_kw: (_ for _ in ()).throw(AssertionError("broker")))
    result = capture.capture_screen("2797", period="2")
    assert result["status"] == "missing"
    assert "one base date" in result["note"] and "no repeated snapshots are summed" in result["note"]
    assert result["scope"] == {
        "appliedFilters": {},
        "effectiveStart": None,
        "effectiveEnd": None,
        "returnedRows": 0,
        "limitedReason": None,
        "unsupported": ["period"],
    }


def test_2797_returns_each_provider_industry_row_for_one_base_date(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(
        gateway,
        "_fetch_rows",
        lambda _api, _path, _body, _key, *, max_pages: ([
            {"inds_cd": "001", "inds_nm": "KOSPI", "ind_netprps": "1"},
            {"inds_cd": "010", "inds_nm": "서비스", "ind_netprps": "2"},
            {"inds_cd": "010", "inds_nm": "duplicate", "ind_netprps": "999"},
        ], True, ""),
    )
    result = capture.capture_screen("2797", market="KOSPI", start="20261024")
    assert result["title"] == "업종별 투자자 기준일 순매수"
    assert [(row["sectorCode"], row["individual"]) for row in result["rows"]] == [("001", 1.0), ("010", 2.0)]
    assert result["complete"] is True
    assert result["scope"] == {
        "appliedFilters": {"market": "KOSPI", "venue": "ALL", "unit": "amount", "start": "20261024"},
        "effectiveStart": "20261024",
        "effectiveEnd": "20261024",
        "returnedRows": 2,
        "limitedReason": None,
        "unsupported": [],
    }


def test_minute_chart_preserves_returned_trading_date_and_non_cumulative_volume(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_fetch_rows", lambda api, path, body, key, **kw: ([
        {"cntr_tm": "20261023153000", "open_pric": "270100", "high_pric": "271000", "low_pric": "269000", "cur_prc": "270500", "acc_trde_qty": "99999"},
        {"cntr_tm": "153000", "open_pric": "270100", "high_pric": "271000", "low_pric": "269000", "cur_prc": "270500"},
    ], True, ""))
    result = capture.capture_screen("0602", interval="5", end="20261024")
    assert result["bars"] == [{"t": "20261023153000", "o": 2701.0, "h": 2710.0, "l": 2690.0, "c": 2705.0, "v": None}]


def test_integrated_investor_codes_preserve_market_totals_and_sector_links(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *a, **kw: ([{"inds_cd": "001_AL", "inds_nm": "KOSPI", "ind_netprps": "-12"}, {"inds_cd": "010_AL", "inds_nm": "서비스", "ind_netprps": "8"}], True, ""))
    assert capture.capture_screen("0780", market="KOSPI")["rows"][0]["individual"] == -12
    assert [row["sectorCode"] for row in capture.capture_screen("2797", market="KOSPI")["rows"]] == ["001", "010"]


def test_investor_index_hundredths_match_industry_quote_and_money_units(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *a, **kw: ([{"inds_cd": "001_AL", "inds_nm": "종합(KOSPI)", "cur_prc": "555030", "pred_pre": "+1653", "flu_rt": "+30", "ind_netprps": "2639"}], True, ""))
    result = capture.capture_screen("0780", market="KOSPI")
    assert (result["rows"][0]["price"], result["rows"][0]["change"], result["rows"][0]["changePct"]) == (5550.30, 16.53, 0.30)
    assert next(c for c in result["columns"] if c["key"] == "individual")["unit"] == "KRW 100m"


@pytest.mark.parametrize("screen", ["0780", "2797"])
def test_investor_provider_outcomes_distinguish_all_failure_empty_and_partial(monkeypatch, screen):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")

    def failed(*_args, **_kwargs):
        raise gateway.BrokerError("synthetic provider failure")

    monkeypatch.setattr(gateway, "_fetch_rows", failed)
    all_failed = capture.capture_screen(screen, market="all", start="20261024")
    assert all_failed["status"] == "error"
    assert all_failed["rows"] == [] and all_failed["complete"] is False
    assert "요청한 모든 시장" in all_failed["note"]

    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: ([], True, ""))
    empty = capture.capture_screen(screen, market="all", start="20261024")
    assert empty["status"] == "missing"
    assert empty["rows"] == [] and empty["complete"] is False
    assert "키움 응답은 성공" in empty["note"]

    def partial(_api, _path, body, _key, *, max_pages):
        if body["mrkt_tp"] == "1":
            raise gateway.BrokerError("synthetic KOSDAQ failure")
        return ([{"inds_cd": "001", "inds_nm": "KOSPI", "ind_netprps": "1"}], True, "")

    monkeypatch.setattr(gateway, "_fetch_rows", partial)
    mixed = capture.capture_screen(screen, market="all", start="20261024")
    assert mixed["status"] == "snapshot"
    assert len(mixed["rows"]) == 1 and mixed["complete"] is False
    assert "KOSDAQ investor feed is unavailable" in mixed["note"]
    assert "수신 결과가 완전하지 않습니다" in mixed["note"]


def test_dynamic_kosdaq_industry_uses_resolved_market_for_summary_members_and_all_table(monkeypatch):
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True)
    monkeypatch.setattr(gateway, "ENVIRONMENT", "real")
    row_calls: list[tuple[str, dict[str, str]]] = []
    page_calls: list[tuple[str, dict[str, str]]] = []

    def fetch_rows(api, _path, body, _key, *, max_pages):
        row_calls.append((api, dict(body)))
        if api == "ka20003" and body["inds_cd"] == "101":
            return ([{"stk_cd": "555", "stk_nm": "동적 코스닥 업종", "cur_prc": "100"}], True, "")
        if api == "ka20003":
            return ([], True, "")
        if api == "ka20002":
            return ([{"stk_cd": "005930", "stk_nm": "구성종목"}], True, "")
        if api == "ka20006":
            return ([], True, "")
        raise AssertionError((api, body))

    def fetch_page(api, _path, body):
        page_calls.append((api, dict(body)))
        if api == "ka20001":
            return SimpleNamespace(body={"cur_prc": "100"}, continuation=SimpleNamespace(has_next=False))
        if api == "ka20009":
            return SimpleNamespace(body={}, continuation=SimpleNamespace(has_next=False))
        raise AssertionError((api, body))

    monkeypatch.setattr(gateway, "_fetch_rows", fetch_rows)
    monkeypatch.setattr(gateway, "_fetch_page", fetch_page)
    monkeypatch.setattr(capture, "_instruments", lambda: {})

    result = capture.capture_screen("0211", sector="555")

    assert result["status"] == "snapshot"
    assert ("ka20001", {"mrkt_tp": "1", "inds_cd": "555"}) in page_calls
    assert ("ka20002", {"mrkt_tp": "1", "inds_cd": "555", "stex_tp": "3"}) in row_calls
    assert [body for api, body in row_calls if api == "ka20003"] == [
        {"inds_cd": "001"},
        {"inds_cd": "101"},
        {"inds_cd": "101"},
    ]
    all_industries = next(section for section in result["sections"] if section["id"] == "all-industries")
    assert all_industries["rows"][0]["sectorCode"] == "555"
