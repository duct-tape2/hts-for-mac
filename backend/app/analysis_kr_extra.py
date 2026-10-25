"""Read-only Korean market views omitted from the initial analysis registry.

The module is deliberately independent of the gateway allowlist.  ``ALLOWED_CALLS``
is a review proposal only; a live request still has to pass
``kiwoom_gateway._fetch_rows`` policy, pacing, and continuation handling.  No
account, order, websocket, or arbitrary-TR route is present here.

The contracts below were transcribed from the installed Kiwoom SDK metadata.
Some names are intentionally conservative: ka10055 is an execution-volume-by-
time response, not a "large trade" scanner, and its HHmmss field has no date.
"""
from __future__ import annotations

import copy
import math
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, TypedDict

from app import kiwoom_gateway as gateway


class FeatureMetadata(TypedDict):
    featureId: str
    title: str
    market: str
    description: str
    parameters: list[dict[str, Any]]
    apiId: str
    path: str


class Column(TypedDict, total=False):
    key: str
    label: str
    numeric: bool
    unit: str


class Spec(TypedDict):
    apiId: str
    path: str
    listKey: str
    title: str
    description: str
    parameters: list[dict[str, Any]]
    fields: list[tuple[str, str, str, bool, str | None, str]]
    body: Callable[[dict[str, Any], str | None], dict[str, str]]
    instrument: bool


_CODE = re.compile(r"^[0-9A-Z]{6}$")
_NUMBER = re.compile(r"^\d+$")
_MAX_PAGES = 5
_FIXTURE_RECEIVED_AT = "2026-10-24T00:00:00Z"


def _select(key: str, label: str, default: str, options: list[tuple[str, str]]) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "type": "select",
        "default": default,
        "options": [{"value": value, "label": item_label} for value, item_label in options],
    }


def _number_parameter(key: str, label: str, default: int, minimum: int, maximum: int) -> dict[str, Any]:
    return {"key": key, "label": label, "type": "number", "default": default, "minimum": minimum, "maximum": maximum}


def _stock_code() -> dict[str, Any]:
    return {"key": "stockCode", "label": "종목코드", "type": "text", "default": ""}


_MARKET_ALL = [("000", "전체"), ("001", "코스피"), ("101", "코스닥")]
_MARKET_LISTED = [("001", "코스피"), ("101", "코스닥")]
_VENUE = [("1", "KRX"), ("2", "NXT"), ("3", "통합")]
_BOOK_STOCK_FILTER = [
    ("0", "전체조회"), ("1", "관리종목 제외"), ("5", "증거금 100% 제외"),
    ("6", "증거금 100%만"), ("7", "증거금 40%만"), ("8", "증거금 30%만"), ("9", "증거금 20%만"),
]
_EXPECTED_STOCK_FILTER = [
    ("0", "전체조회"), ("1", "관리종목 제외"), ("3", "우선주 제외"), ("4", "관리종목·우선주 제외"),
    ("5", "증거금 100% 제외"), ("6", "증거금 100%만"), ("7", "증거금 40%만"),
    ("8", "증거금 30%만"), ("9", "증거금 20%만"), ("11", "정리매매종목 제외"),
    ("12", "증거금 50%만"), ("13", "증거금 60%만"), ("14", "ETF 제외"),
    ("15", "스팩 제외"), ("16", "ETF·ETN 제외"),
]
_AFTER_HOURS_STOCK_FILTER = [
    ("0", "전체조회"), ("1", "관리종목 제외"), ("2", "정리매매종목 제외"), ("3", "우선주 제외"),
    ("4", "관리종목·우선주 제외"), ("5", "증거금 100% 제외"), ("6", "증거금 100%만"),
    ("7", "증거금 40%만"), ("8", "증거금 30%만"), ("9", "증거금 20%만"),
    ("12", "증거금 50%만"), ("13", "증거금 60%만"),
    ("14", "ETF 제외"), ("15", "스팩 제외"), ("16", "ETF·ETN 제외"), ("17", "ETN 제외"),
]
_CREDIT_FILTER = [
    ("0", "전체조회"), ("1", "신용융자 A군"), ("2", "신용융자 B군"), ("3", "신용융자 C군"),
    ("4", "신용융자 D군"), ("5", "신용한도초과 제외"), ("7", "신용융자 E군"),
    ("8", "신용대주"), ("9", "신용융자 전체"),
]
_BOOK_VOLUME_SURGE = [("1", "1천주 이상"), ("5", "5천주 이상"), ("10", "1만주 이상"), ("50", "5만주 이상"), ("100", "10만주 이상")]
_EXPECTED_VOLUME = [("0", "전체조회"), ("1", "1천주 이상"), ("3", "3천주 이상"), ("5", "5천주 이상"), ("10", "1만주 이상"), ("50", "5만주 이상"), ("100", "10만주 이상")]
_AFTER_HOURS_VOLUME = [("0", "전체조회"), ("10", "1백주 이상"), ("50", "5백주 이상"), ("100", "1천주 이상"), ("500", "5천주 이상"), ("1000", "1만주 이상"), ("5000", "5만주 이상"), ("10000", "10만주 이상")]
_AFTER_HOURS_VALUE = [("0", "전체조회"), ("5", "5백만원 이상"), ("10", "1천만원 이상"), ("30", "3천만원 이상"), ("50", "5천만원 이상"), ("100", "1억원 이상"), ("300", "3억원 이상"), ("500", "5억원 이상"), ("1000", "10억원 이상"), ("3000", "30억원 이상"), ("5000", "50억원 이상"), ("10000", "100억원 이상")]


def _body_expected(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {
        "mrkt_tp": params["market"], "sort_tp": params["sort"], "trde_qty_cnd": params["minimumVolume"],
        "stk_cnd": params["stockFilter"], "crd_cnd": params["creditFilter"], "pric_cnd": params["priceFilter"],
        "stex_tp": params["venue"],
    }


def _body_book_quantity(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {
        "mrkt_tp": params["market"], "trde_tp": params["side"], "sort_tp": params["sort"],
        "tm_tp": str(params["minutes"]), "trde_qty_tp": params["minimumVolume"],
        "stk_cnd": params["stockFilter"], "stex_tp": params["venue"],
    }


def _body_book_ratio(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {
        "mrkt_tp": params["market"], "rt_tp": params["ratioSide"], "tm_tp": str(params["minutes"]),
        "trde_qty_tp": params["minimumVolume"], "stk_cnd": params["stockFilter"], "stex_tp": params["venue"],
    }


def _body_concentration(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {
        "mrkt_tp": params["market"], "prps_cnctr_rt": str(params["concentrationPct"]),
        "cur_prc_entry": params["includeCurrentPrice"], "prpscnt": str(params["bandCount"]),
        "cycle_tp": params["cycleDays"], "stex_tp": params["venue"],
    }


def _body_after_hours(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    # ka10098 has no stex_tp request field in the installed SDK specification.
    return {
        "mrkt_tp": params["market"], "sort_base": params["sort"], "stk_cnd": params["stockFilter"],
        "trde_qty_cnd": params["minimumVolume"], "crd_cnd": params["creditFilter"], "trde_prica": params["minimumValue"],
    }


def _body_execution_volume(params: dict[str, Any], code: str | None) -> dict[str, str]:
    if not code:
        raise gateway.BrokerError("stockCode is required")
    return {"stk_cd": code, "tdy_pred": params["day"]}


_EXPECTED_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("expectedPrice", "exp_cntr_pric", "예상체결가", True, "KRW", "price"), ("basePrice", "base_pric", "기준가", True, "KRW", "price"),
    ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("expectedQuantity", "exp_cntr_qty", "예상체결량", True, "shares", "number"),
    ("askQuantity", "sel_req", "매도잔량", True, "shares", "number"), ("ask", "sel_bid", "매도호가", True, "KRW", "price"),
    ("bid", "buy_bid", "매수호가", True, "KRW", "price"), ("bidQuantity", "buy_req", "매수잔량", True, "shares", "number"),
]
_BOOK_QUANTITY_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "price"), ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("referenceQuantity", "int", "기준량", True, "shares", "number"),
    ("currentQuantity", "now", "현재량", True, "shares", "number"), ("surgeQuantity", "sdnin_qty", "급증수량", True, "shares", "number"),
    ("surgePct", "sdnin_rt", "급증률", True, "percent", "number"), ("totalBuyQuantity", "tot_buy_qty", "총매수량", True, "shares", "number"),
]
_BOOK_RATIO_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "price"), ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("referenceRatio", "int", "기준률", True, "percent", "number"),
    ("currentRatio", "now_rt", "현재비율", True, "percent", "number"), ("surgePct", "sdnin_rt", "급증률", True, "percent", "number"),
    ("totalAskQuantity", "tot_sel_req", "총매도잔량", True, "shares", "number"), ("totalBidQuantity", "tot_buy_req", "총매수잔량", True, "shares", "number"),
]
_CONCENTRATION_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "price"), ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("currentVolume", "now_trde_qty", "현재거래량", True, "shares", "number"), ("rangeStart", "pric_strt", "가격대시작", True, "KRW", "price"),
    ("rangeEnd", "pric_end", "가격대끝", True, "KRW", "price"), ("concentrationQuantity", "prps_qty", "매물량", True, "shares", "number"),
    ("concentrationPct", "prps_rt", "매물비", True, "percent", "number"),
]
_AFTER_HOURS_FIELDS = [
    ("rank", "rank", "순위", True, None, "number"), ("code", "stk_cd", "종목코드", False, None, "text"),
    ("name", "stk_nm", "종목명", False, None, "text"), ("price", "cur_prc", "현재가", True, "KRW", "price"),
    ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("totalAskQuantity", "sel_tot_req", "매도총잔량", True, "shares", "number"),
    ("totalBidQuantity", "buy_tot_req", "매수총잔량", True, "shares", "number"), ("accumulatedVolume", "acc_trde_qty", "누적거래량", True, "shares", "number"),
    ("accumulatedValue", "acc_trde_prica", "누적거래대금", True, "KRW millions", "number"), ("dayClose", "tdy_close_pric", "당일종가", True, "KRW", "price"),
    ("dayCloseChangePct", "tdy_close_pric_flu_rt", "당일종가등락률", True, "percent", "number"),
]
_EXECUTION_VOLUME_FIELDS = [
    # ``cntr_tm`` is a provider HHmmss string; no date or timestamp is inferred.
    ("executionTime", "cntr_tm", "체결시간(HHmmss)", False, None, "text"), ("price", "cntr_pric", "체결가", True, "KRW", "price"),
    ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("executionQuantity", "cntr_qty", "체결량", True, "shares", "number"),
    ("accumulatedVolume", "acc_trde_qty", "누적거래량", True, "shares", "number"), ("accumulatedValue", "acc_trde_prica", "누적거래대금", True, "KRW millions", "number"),
]


def _spec(api_id: str, path: str, list_key: str, title: str, description: str, parameters: list[dict[str, Any]], fields: list[tuple[str, str, str, bool, str | None, str]], body: Callable[[dict[str, Any], str | None], dict[str, str]], *, instrument: bool = False) -> Spec:
    return {"apiId": api_id, "path": path, "listKey": list_key, "title": title, "description": description, "parameters": parameters, "fields": fields, "body": body, "instrument": instrument}


_SPECS: dict[str, Spec] = {
    "kr_expected_execution_rank": _spec("ka10029", "/api/dostk/rkinfo", "exp_cntr_flu_rt_upper", "예상체결 등락률 상위", "공급자가 반환한 예상체결가·예상체결량 순위입니다. 현재 체결/OHLC가 아닙니다.", [
        _select("market", "시장", "000", _MARKET_ALL), _select("sort", "정렬", "1", [("1", "상승률"), ("2", "상승폭"), ("3", "보합"), ("4", "하락률"), ("5", "하락폭"), ("6", "체결량"), ("7", "상한"), ("8", "하한")]),
        _select("minimumVolume", "거래량 조건", "0", _EXPECTED_VOLUME), _select("stockFilter", "종목 조건", "0", _EXPECTED_STOCK_FILTER), _select("creditFilter", "신용 조건", "0", _CREDIT_FILTER),
        _select("priceFilter", "가격 조건", "0", [("0", "전체조회"), ("1", "1천원 미만"), ("2", "1천원~2천원"), ("3", "2천원~5천원"), ("4", "5천원~1만원"), ("5", "1만원 이상"), ("8", "1천원 이상"), ("10", "1만원 미만")]), _select("venue", "거래소", "3", _VENUE),
    ], _EXPECTED_FIELDS, _body_expected),
    "kr_orderbook_quantity_surge": _spec("ka10021", "/api/dostk/rkinfo", "bid_req_sdnin", "호가잔량 급증", "공급자가 계산한 매수 또는 매도 호가잔량 급증 순위입니다.", [
        _select("market", "시장", "001", _MARKET_LISTED), _select("side", "잔량 구분", "1", [("1", "매수잔량"), ("2", "매도잔량")]), _select("sort", "정렬", "1", [("1", "급증량"), ("2", "급증률")]),
        _number_parameter("minutes", "시간 구분(분)", 30, 1, 99), _select("minimumVolume", "거래량 조건", "1", _BOOK_VOLUME_SURGE), _select("stockFilter", "종목 조건", "0", _BOOK_STOCK_FILTER), _select("venue", "거래소", "3", _VENUE),
    ], _BOOK_QUANTITY_FIELDS, _body_book_quantity),
    "kr_orderbook_ratio_surge": _spec("ka10022", "/api/dostk/rkinfo", "req_rt_sdnin", "호가잔량 비율 급증", "공급자가 계산한 매수/매도 또는 매도/매수 비율 급증 순위입니다.", [
        _select("market", "시장", "001", _MARKET_LISTED), _select("ratioSide", "비율 구분", "1", [("1", "매수/매도"), ("2", "매도/매수")]), _number_parameter("minutes", "시간 구분(분)", 30, 1, 99),
        _select("minimumVolume", "거래량 조건", "5", _BOOK_VOLUME_SURGE[1:]), _select("stockFilter", "종목 조건", "0", _BOOK_STOCK_FILTER), _select("venue", "거래소", "3", _VENUE),
    ], _BOOK_RATIO_FIELDS, _body_book_ratio),
    "kr_price_concentration": _spec("ka10025", "/api/dostk/stkinfo", "prps_cnctr", "매물대 집중", "공급자의 지정 기간·비율 조건 매물대 집중 결과입니다. 실제 체결 분포를 자체 재구성하지 않습니다.", [
        _select("market", "시장", "000", _MARKET_ALL), _number_parameter("concentrationPct", "매물집중비율(%)", 50, 0, 100), _select("includeCurrentPrice", "현재가 매물대 진입", "0", [("0", "미포함"), ("1", "포함")]),
        _number_parameter("bandCount", "매물대수", 10, 1, 99), _select("cycleDays", "주기", "50", [("50", "50일"), ("100", "100일"), ("150", "150일"), ("200", "200일"), ("250", "250일"), ("300", "300일")]), _select("venue", "거래소", "3", _VENUE),
    ], _CONCENTRATION_FIELDS, _body_concentration),
    "kr_after_hours_single_price_rank": _spec("ka10098", "/api/dostk/rkinfo", "ovt_sigpric_flu_rt_rank", "시간외 단일가 등락률 순위", "공급자 시간외 단일가 순위와 총 호가잔량입니다. 요청 계약에는 거래소 파라미터가 없습니다.", [
        _select("market", "시장", "000", _MARKET_ALL), _select("sort", "정렬", "1", [("1", "상승률"), ("2", "상승폭"), ("3", "하락률"), ("4", "하락폭"), ("5", "보합")]), _select("stockFilter", "종목 조건", "0", _AFTER_HOURS_STOCK_FILTER),
        _select("minimumVolume", "거래량 조건", "0", _AFTER_HOURS_VOLUME), _select("creditFilter", "신용 조건", "0", _CREDIT_FILTER), _select("minimumValue", "거래대금 조건", "0", _AFTER_HOURS_VALUE),
    ], _AFTER_HOURS_FIELDS, _body_after_hours),
    "kr_today_previous_execution_volume": _spec("ka10055", "/api/dostk/stkinfo", "tdy_pred_cntr_qty", "당일·전일 체결량", "종목별 당일 또는 전일 체결량 목록입니다. 대량체결 여부는 제공하지 않으며 체결시간에는 날짜를 합성하지 않습니다.", [
        _stock_code(), _select("day", "당일·전일", "1", [("1", "당일"), ("2", "전일")]),
    ], _EXECUTION_VOLUME_FIELDS, _body_execution_volume, instrument=True),
}

FEATURES: dict[str, FeatureMetadata] = {
    feature_id: {
        "featureId": feature_id, "title": spec["title"], "market": "KR", "description": spec["description"],
        "parameters": copy.deepcopy(spec["parameters"]), "apiId": spec["apiId"], "path": spec["path"],
    }
    for feature_id, spec in _SPECS.items()
}

# Proposal for the gateway owner.  Defining this set does not authorize the calls.
ALLOWED_CALLS: set[tuple[str, str]] = {(spec["apiId"], spec["path"]) for spec in _SPECS.values()}


def _columns(fields: list[tuple[str, str, str, bool, str | None, str]]) -> list[Column]:
    return [{"key": key, "label": label, "numeric": numeric, **({"unit": unit} if unit else {})} for key, _source, label, numeric, unit, _conversion in fields]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalise(spec: Spec, params: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(params, dict):
        raise gateway.BrokerError("params must be an object")
    definitions = {str(item["key"]): item for item in spec["parameters"]}
    if set(params).difference(definitions):
        raise gateway.BrokerError("unsupported feature parameter")
    result: dict[str, Any] = {}
    for key, definition in definitions.items():
        value = params.get(key, definition["default"])
        if definition["type"] == "select":
            value = str(value)
            if value not in {str(option["value"]) for option in definition["options"]}:
                raise gateway.BrokerError(f"invalid {key}")
        elif definition["type"] == "number":
            text = str(value).strip()
            if not _NUMBER.fullmatch(text):
                raise gateway.BrokerError(f"invalid {key}")
            value = int(text)
            if value < int(definition["minimum"]) or value > int(definition["maximum"]):
                raise gateway.BrokerError(f"invalid {key}")
        else:
            value = str(value or "").strip().upper()
            if key == "stockCode" and value and not _CODE.fullmatch(value):
                raise gateway.BrokerError("stockCode must be a six-character KRX code")
        result[key] = value
    return result


def _instrument_code(params: dict[str, Any], instrument: dict[str, Any] | None, *, required: bool) -> tuple[str | None, dict[str, Any] | None]:
    requested = str(params.get("stockCode") or "").upper()
    if instrument is None:
        if not requested:
            if required:
                raise gateway.BrokerError("stockCode is required")
            return None, None
        identity = gateway._identity(market="KR", stk_cd=requested, stex_tp="KRX", listing_venue="KOSPI")
        return identity["stkCd"], identity
    if not isinstance(instrument, dict) or str(instrument.get("market") or "").upper() != "KR":
        raise gateway.BrokerError("instrument must be a KR instrument")
    identity = gateway._identity(market="KR", stk_cd=str(instrument.get("stkCd") or ""), stex_tp=instrument.get("stexTp"), listing_venue=instrument.get("listingVenue"))
    if requested and requested != identity["stkCd"]:
        raise gateway.BrokerError("stockCode does not match instrument")
    return identity["stkCd"], identity


def _numeric(value: object, *, price: bool) -> float | None:
    if value is None or str(value).strip() in {"", "-"}:
        return None
    try:
        number = float(Decimal(str(value).strip().replace(",", "")))
    except (InvalidOperation, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return abs(number) if price else number


def _value(raw: dict[str, Any], source: str, numeric: bool, conversion: str) -> str | float | None:
    value = raw.get(source)
    if numeric:
        return _numeric(value, price=conversion == "price")
    text = str(value or "").strip()
    return text or None


def _indexed() -> dict[str, dict[str, Any]]:
    if not gateway.KIWOOM_ENABLED:
        return {}
    rows, _complete, _note = gateway._indexed("KR")
    return {
        str(row.get("stkCd") or "").upper(): row
        for row in rows
        if isinstance(row, dict) and row.get("market") == "KR" and _CODE.fullmatch(str(row.get("stkCd") or "").upper())
    }


def _display_instrument(identity: dict[str, Any] | None, index: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """Return a strict UI Instrument without trusting an arbitrary row name.

    The analysis route canonicalises identity with ``gateway._identity``;
    that helper intentionally has no display name.  Prefer the verified shared
    index.  When it has not loaded, the canonical code is the only truthful
    display fallback, rather than a provider row's unverified ``stk_nm``.
    """
    if identity is None:
        return None
    indexed = index.get(str(identity.get("stkCd") or "").upper())
    if indexed is not None:
        return copy.deepcopy(indexed)
    return {**copy.deepcopy(identity), "stkNm": str(identity["stkCd"])}


def _rows(feature_id: str, spec: Spec, raw_rows: list[dict[str, Any]], index: dict[str, dict[str, Any]], requested: dict[str, Any] | None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for position, raw in enumerate(raw_rows, start=1):
        if not isinstance(raw, dict):
            continue
        row = {key: _value(raw, source, numeric, conversion) for key, source, _label, numeric, _unit, conversion in spec["fields"]}
        code = str(raw.get("stk_cd") or "").strip().upper()
        row["id"] = f"{feature_id}:{code or raw.get('cntr_tm') or position}:{position}"
        if code in index:
            row["instrument"] = copy.deepcopy(index[code])
        elif requested is not None:
            row["instrument"] = copy.deepcopy(requested)
        rows.append(row)
    return rows


def _fixture_rows(feature_id: str, code: str | None) -> list[dict[str, Any]]:
    stock = code or "005930"
    fixtures: dict[str, list[dict[str, Any]]] = {
        "kr_expected_execution_rank": [{"stk_cd": stock, "stk_nm": "가상 종목", "exp_cntr_pric": "+71500", "base_pric": "71000", "pred_pre_sig": "2", "pred_pre": "+500", "flu_rt": "+0.70", "exp_cntr_qty": "120", "sel_req": "40", "sel_bid": "+71600", "buy_bid": "+71500", "buy_req": "55"}],
        "kr_orderbook_quantity_surge": [{"stk_cd": stock, "stk_nm": "가상 종목", "cur_prc": "+71500", "pred_pre_sig": "2", "pred_pre": "+500", "int": "100", "now": "180", "sdnin_qty": "80", "sdnin_rt": "+80.00", "tot_buy_qty": "500"}],
        "kr_orderbook_ratio_surge": [{"stk_cd": stock, "stk_nm": "가상 종목", "cur_prc": "+71500", "pred_pre_sig": "2", "pred_pre": "+500", "int": "120.00", "now_rt": "150.00", "sdnin_rt": "+30.00", "tot_sel_req": "100", "tot_buy_req": "150"}],
        "kr_price_concentration": [{"stk_cd": stock, "stk_nm": "가상 종목", "cur_prc": "+71500", "pred_pre_sig": "2", "pred_pre": "+500", "flu_rt": "+0.70", "now_trde_qty": "1200", "pric_strt": "70000", "pric_end": "72000", "prps_qty": "300", "prps_rt": "25.00"}],
        "kr_after_hours_single_price_rank": [{"rank": "1", "stk_cd": stock, "stk_nm": "가상 종목", "cur_prc": "+71500", "pred_pre_sig": "2", "pred_pre": "+500", "flu_rt": "+0.70", "sel_tot_req": "100", "buy_tot_req": "150", "acc_trde_qty": "1000", "acc_trde_prica": "70", "tdy_close_pric": "71000", "tdy_close_pric_flu_rt": "+0.20"}],
        "kr_today_previous_execution_volume": [{"cntr_tm": "153000", "cntr_pric": "+71500", "pred_pre_sig": "2", "pred_pre": "+500", "flu_rt": "+0.70", "cntr_qty": "20", "acc_trde_qty": "1000", "acc_trde_prica": "70"}],
    }
    return fixtures[feature_id]


def _response(feature_id: str, spec: Spec, params: dict[str, Any], *, source: str, status: str, complete: bool, note: str, rows: list[dict[str, Any]], code: str | None, instrument: dict[str, Any] | None) -> dict[str, Any]:
    scope: dict[str, Any] = {
        "parameters": copy.deepcopy(params), "apiId": spec["apiId"], "path": spec["path"], "listKey": spec["listKey"], "returnedRows": len(rows),
    }
    if code:
        scope["resolvedStockCode"] = code
    if instrument:
        scope["requestedInstrument"] = copy.deepcopy(instrument)
    return {
        "featureId": feature_id, "title": spec["title"], "market": "KR", "source": source, "status": status,
        "receivedAt": _FIXTURE_RECEIVED_AT if source == "fixture" else _now(), "asOf": None, "note": note,
        "complete": complete, "parameters": copy.deepcopy(params), "scope": scope, "columns": _columns(spec["fields"]), "rows": rows,
    }


def get_feature(feature_id: str, params: dict[str, Any], *, instrument: dict[str, Any] | None = None) -> dict[str, Any]:
    """Fetch one bounded public-market view, never falling back to fake live data."""
    if feature_id not in _SPECS:
        raise gateway.BrokerError("unsupported KR extra analysis feature")
    spec = _SPECS[feature_id]
    selected = _normalise(spec, params)
    # Ranking rows must be identified from the verified shared index, never
    # attached to the currently selected panel instrument.
    code, identity = _instrument_code(selected, instrument if spec["instrument"] else None, required=spec["instrument"])
    body = spec["body"](selected, code)
    display_identity = _display_instrument(identity, {})
    if not gateway.KIWOOM_ENABLED:
        if str(gateway.ENVIRONMENT) != "fixture":
            return _response(feature_id, spec, selected, source="kiwoom", status="error", complete=False, note="Kiwoom read is disabled outside fixture mode.", rows=[], code=code, instrument=display_identity)
        rows = _rows(feature_id, spec, _fixture_rows(feature_id, code), {}, display_identity)
        return _response(feature_id, spec, selected, source="fixture", status="fixture", complete=True, note="Deterministic fixture/test data; no broker request was made.", rows=rows, code=code, instrument=display_identity)
    try:
        index = _indexed()
        display_identity = _display_instrument(identity, index)
        raw_rows, complete, provider_note = gateway._fetch_rows(spec["apiId"], spec["path"], body, spec["listKey"], max_pages=_MAX_PAGES)
        rows = _rows(feature_id, spec, raw_rows, index, display_identity)
    except gateway.BrokerError as exc:
        return _response(feature_id, spec, selected, source="kiwoom", status="error", complete=False, note=f"{gateway.read_failure_note(exc)}", rows=[], code=code, instrument=display_identity)
    note = provider_note or ("" if complete else "Provider pagination is incomplete.")
    return _response(feature_id, spec, selected, source="kiwoom", status="snapshot" if rows else "missing", complete=bool(complete), note=note, rows=rows, code=code, instrument=display_identity)
