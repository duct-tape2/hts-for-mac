import pytest

from app import condition_search as conditions


def test_feature_registry_declares_list_result_and_explicit_live_activation():
    result = conditions.get_feature("saved-condition-result")
    assert result["requestSchema"]["seq"]["pattern"] == "^[0-9]{1,20}$"
    assert result["requestSchema"]["venue"]["KR"] == ["KRX"]
    assert conditions.get_feature("saved-condition-live")["readSemantics"] == "explicit activation only; never enabled by list/result reads"
    assert conditions.get_feature("unknown") is None


def test_verified_kr_and_us_packets_preserve_distinct_protocol_names():
    kr = conditions.build_command("KR", "result", seq="4")
    us = conditions.build_command("US", "result", seq="0")
    assert kr.api_id == "ka10172"
    assert kr.packet == {"trnm": "CNSRREQ", "seq": "4", "search_type": "0", "stex_tp": "K", "cont_yn": "N", "next_key": ""}
    assert us.api_id == "usa20281"
    assert us.packet == {"trnm": "GCNSRREQ", "seq": "0", "search_type": "0", "cont_yn": "N", "next_key": ""}
    with pytest.raises(conditions.ConditionInputError):
        conditions.build_command("US", "result", seq="0", venue="KRX")


def test_fixture_results_are_explicit_and_never_live():
    result = conditions.fixture_result("US", "0", realtime=True)
    assert result["source"] == result["status"] == "fixture"
    assert result["realtime"] is False
    assert "no broker request" in result["note"]


def test_normal_result_preserves_unknown_scalar_fields_for_safe_raw_display():
    spec = conditions.build_command("KR", "result", seq="4")
    page = conditions.parse_result_page("KR", spec, {
        "trnm": "CNSRREQ", "return_code": 0, "seq": "4", "cont_yn": "N",
        "data": [{"9001": "A005930", "302": "삼성전자", "unverified_field": "kept"}],
    })
    assert page["rows"] == [{
        "item": "A005930", "name": "삼성전자", "exchange": None,
        "fields": {"9001": "A005930", "302": "삼성전자", "unverified_field": "kept"},
    }]


def test_documented_live_membership_event_preserves_raw_values_without_timestamp():
    events = conditions.parse_live_membership_events("US", {
        "trnm": "REAL",
        "data": [{"type": "S2", "name": "조건검색", "item": "COIN", "stexTp": "ND", "values": {"841": "2", "9001": "COIN", "843": "I", "20": "230156", "907": "2"}}],
    })
    assert events == [{
        "market": "US", "seq": "2", "item": "COIN", "action": "I", "eventType": "S2", "name": "조건검색", "exchange": "ND",
        "fields": {"841": "2", "9001": "COIN", "843": "I", "20": "230156", "907": "2"},
        "sourceTimestamp": None, "timeNote": "Raw provider time is retained in fields; timezone/date are not derived.",
    }]
