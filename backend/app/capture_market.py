"""Fixed, read-only adapters for captured HTS market screens."""
from __future__ import annotations

import math
import re
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from threading import Lock, Thread
from typing import Any, NotRequired, TypedDict

from app import kiwoom_gateway as gateway


class Column(TypedDict, total=False):
    key: str
    label: str
    unit: str
    numeric: bool


class Section(TypedDict):
    id: str
    title: str
    columns: list[Column]
    rows: list[dict[str, Any]]
    source: str
    status: str
    asOf: str | None
    note: str


class Scope(TypedDict):
    appliedFilters: dict[str, str]
    effectiveStart: str | None
    effectiveEnd: str | None
    returnedRows: int
    limitedReason: str | None
    unsupported: list[str]


class CapturePayload(TypedDict):
    screen: str
    title: str
    source: str
    status: str
    environment: str
    receivedAt: str | None
    asOf: str | None
    note: str
    complete: bool
    columns: list[Column]
    rows: list[dict[str, Any]]
    sections: NotRequired[list[Section]]
    bars: NotRequired[list[dict[str, Any]]]
    news: NotRequired[list[dict[str, Any]]]
    scope: NotRequired[Scope]
    selectionPending: NotRequired[bool]


class InputError(ValueError):
    pass


_MARKETS = {"all": "000", "KOSPI": "001", "KOSDAQ": "101"}
_VENUES = {"KRX": "1", "NXT": "2", "ALL": "3"}
_INTERVALS = {"1", "3", "5", "10", "15", "30", "60", "D", "W", "M", "Y"}
_SESSIONS = {"all": "0", "regular": "1", "preMarket": "2", "afterMarket": "3"}
_RANK_STOCKS = {"all": "0", "excludeManaged": "1", "excludePreferred": "3", "excludeManagedPreferred": "4", "excludeEtf": "14", "excludeEtfEtn": "16"}
_RANK_CREDITS = {"all": "0", "creditAll": "9", "creditA": "1", "creditB": "2", "creditC": "3", "creditD": "4", "loan": "8"}
_RANK_VOLUMES = {"all": "0", "5k": "5", "10k": "10", "50k": "50", "100k": "100", "200k": "200", "300k": "300", "1m": "1000"}
_RANK_PRICES = {"all": "0", "under1k": "1", "over1k": "2", "1to2k": "3", "2to5k": "4", "over5k": "5", "5to10k": "6", "under10k": "10", "over10k": "7", "over50k": "8", "over100k": "9"}
_RANK_VALUES = {"all": "0", "10m": "1", "30m": "3", "50m": "4", "100m": "10", "300m": "30", "500m": "50", "1b": "100", "3b": "300", "5b": "500", "10b": "1000", "30b": "3000", "50b": "5000"}
_LIMIT_SORTS = {"code": "1", "streak": "2", "changePct": "3"}
_LIMIT_STOCKS = {"all": "0", "excludeManaged": "1", "excludePreferred": "3", "excludeManagedPreferred": "4"}
_LIMIT_CREDITS = {"all": "0", "creditAll": "9", "creditA": "1", "creditB": "2", "creditC": "3", "creditD": "4", "creditE": "7"}
_LIMIT_VOLUMES = {"all": "00000", "10k": "00010", "50k": "00050", "100k": "00100", "150k": "00150", "200k": "00200", "300k": "00300", "500k": "00500", "1m": "01000"}
_LIMIT_PRICES = {"all": "0", "under1k": "1", "1to2k": "2", "2to3k": "3", "5to10k": "4", "over10k": "5", "over1k": "8"}
_MANAGED = {"exclude": "0", "include": "1"}
_KNOWN = frozenset({"0198", "0187", "0186", "0184", "0162", "0130", "0601", "0602", "0211", "0780", "2797", "0200", "0700"})
_CODE = re.compile(r"^[0-9A-Z]{6}$")
_SECTOR = re.compile(r"^[0-9]{3}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _day() -> str:
    return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")


def _number(value: object, *, absolute: bool = False, price: bool = False) -> float | None:
    if value is None or str(value).strip() in {"", "-"}:
        return None
    try:
        result = float(Decimal(str(value).strip().replace(",", "")))
    except (InvalidOperation, ValueError):
        return None
    if not math.isfinite(result) or (price and result == 0):
        return None
    return 0.0 if result == 0 else abs(result) if absolute else result


def _text(value: object) -> str | None:
    result = str(value or "").strip()
    return result or None


def _base_code(value: object) -> str:
    """Normalize only the documented venue suffix, preserving leading zeros."""
    return re.sub(r"_(?:AL|NX)$", "", str(value or "").strip().upper())


def _date(value: str | None, name: str) -> str | None:
    if value in {None, ""}:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{8}", value):
        raise InputError(f"{name} must be YYYYMMDD")
    try:
        datetime.strptime(value, "%Y%m%d")
    except ValueError as exc:
        raise InputError(f"{name} must be YYYYMMDD") from exc
    return value


def normalize_query(**values: Any) -> dict[str, str | None]:
    """Reject every malformed field before an index or broker request."""
    market = str(values.get("market", "all") or "").strip()
    market = "all" if market.lower() == "all" else market.upper()
    venue = str(values.get("venue", "ALL") or "").strip().upper()
    sort = str(values.get("sort", "volume") or "").strip().lower()
    direction = str(values.get("direction", "up") or "").strip().lower()
    direction = {"previousuplimit": "previousUpLimit", "previousdownlimit": "previousDownLimit"}.get(direction, direction)
    interval = str(values.get("interval", "D") or "").strip().upper()
    sector = str(values.get("sector", "001") or "").strip()
    unit = str(values.get("unit", "amount") or "").strip().lower()
    period = str(values.get("period", "1") or "").strip()
    provider = str(values.get("provider", "all") or "").strip().lower()
    query = str(values.get("query", "") or "").strip()
    session = str(values.get("session", "all") or "").strip()
    stock = str(values.get("stock", "all") or "").strip()
    credit = str(values.get("credit", "all") or "").strip()
    volume_band = str(values.get("volumeBand", "all") or "").strip()
    price_band = str(values.get("priceBand", "all") or "").strip()
    value_band = str(values.get("valueBand", "all") or "").strip()
    limit_sort = str(values.get("limitSort", "changePct") or "").strip()
    managed = str(values.get("managed", "exclude") or "").strip()
    if market not in _MARKETS: raise InputError("unsupported market")
    if venue not in _VENUES: raise InputError("unsupported venue")
    if sort not in {"volume", "turnover", "value"}: raise InputError("unsupported sort")
    if direction not in {"up", "down", "rise", "fall", "flat", "previousUpLimit", "previousDownLimit"}: raise InputError("unsupported direction")
    if interval not in _INTERVALS: raise InputError("unsupported interval")
    if not _SECTOR.fullmatch(sector): raise InputError("sector must be a three-digit code")
    if unit not in {"amount", "volume"}: raise InputError("unsupported unit")
    if period not in {"1", "2", "3", "4", "5"}: raise InputError("unsupported period")
    if session not in _SESSIONS: raise InputError("unsupported session")
    if stock not in set(_RANK_STOCKS) | set(_LIMIT_STOCKS): raise InputError("unsupported stock")
    if credit not in set(_RANK_CREDITS) | set(_LIMIT_CREDITS): raise InputError("unsupported credit")
    if volume_band not in set(_RANK_VOLUMES) | set(_LIMIT_VOLUMES): raise InputError("unsupported volume band")
    if price_band not in set(_RANK_PRICES) | set(_LIMIT_PRICES): raise InputError("unsupported price band")
    if value_band not in _RANK_VALUES: raise InputError("unsupported value band")
    if limit_sort not in _LIMIT_SORTS: raise InputError("unsupported limit sort")
    if managed not in _MANAGED: raise InputError("unsupported managed")
    if len(provider) > 32 or any(ord(char) < 32 for char in provider): raise InputError("provider is invalid")
    if len(query) > 100 or any(ord(char) < 32 for char in query): raise InputError("query must be at most 100 printable characters")
    start, end = _date(values.get("start"), "start"), _date(values.get("end"), "end")
    if start and end and start > end: raise InputError("start must not be after end")
    return {"market": market, "venue": venue, "sort": sort, "direction": direction, "interval": interval, "sector": sector, "start": start, "end": end, "unit": unit, "period": period, "provider": provider, "query": query, "session": session, "stock": stock, "credit": credit, "volumeBand": volume_band, "priceBand": price_band, "valueBand": value_band, "limitSort": limit_sort, "managed": managed}


def _payload(screen: str, title: str, *, source: str, status: str, note: str, complete: bool, columns: list[Column] | None = None, rows: list[dict[str, Any]] | None = None, as_of: str | None = None, sections: list[Section] | None = None, bars: list[dict[str, Any]] | None = None, news: list[dict[str, Any]] | None = None, received_at: str | None = None, selection_pending: bool = False) -> CapturePayload:
    resolved_columns = columns or []
    result: CapturePayload = {"screen": screen, "title": title, "source": source, "status": status, "environment": str(gateway.ENVIRONMENT), "receivedAt": None if status == "missing" else received_at or _now(), "asOf": as_of, "note": note, "complete": complete, "columns": resolved_columns, "rows": _fill_cells(rows or [], resolved_columns)}
    if sections is not None: result["sections"] = sections
    if bars is not None: result["bars"] = bars
    if news is not None: result["news"] = news
    if selection_pending: result["selectionPending"] = True
    return result


def _fill_cells(rows: list[dict[str, Any]], columns: list[Column]) -> list[dict[str, Any]]:
    """The frontend schema requires every visible cell to be explicit."""
    keys = [str(column["key"]) for column in columns]
    return [{**row, **{key: row.get(key) for key in keys}} for row in rows]


def _fixture(screen: str, title: str, columns: list[Column], rows: list[dict[str, Any]], note: str = "") -> CapturePayload:
    return _payload(screen, title, source="fixture", status="fixture", note=note or "Deterministic fixture/test data; no upstream request was made.", complete=True, columns=columns, rows=rows, as_of="2026-10-24")


def _missing(screen: str, title: str, note: str) -> CapturePayload:
    return _payload(screen, title, source="unavailable", status="missing", note=note, complete=False)


def _one_base_date(query: dict[str, str | None]) -> str:
    """Return the exact ka10051 base date after its one-day constraint."""
    return str(query["end"] or query["start"] or _day())


def _investor_period_is_supported(query: dict[str, str | None]) -> bool:
    return bool(query["period"] == "1" and not (query["start"] and query["end"] and query["start"] != query["end"]))


def _screen_scope(
    screen: str, query: dict[str, str | None], payload: CapturePayload
) -> Scope:
    """Describe only filters the returned payload actually applied.

    Fixture and unavailable paths intentionally do not claim that broker-side
    filtering happened.  This keeps the scope useful to the UI instead of
    echoing every accepted query parameter as a misleading promise.
    """
    dynamic = payload.get("source") not in {"fixture", "unavailable"} and payload.get("status") != "error"
    applied: dict[str, str] = {}
    effective_start: str | None = None
    effective_end: str | None = None
    unsupported: list[str] = []
    limited_reason: str | None = None

    # 2797 has no verified multi-day aggregation.  Its date contract is
    # explicit even in fixture mode because the fixture row is keyed by this
    # exact base date and never represents a period sum.
    investor_period_supported = _investor_period_is_supported(query)
    if screen == "2797":
        if investor_period_supported:
            effective_start = effective_end = _one_base_date(query)
        else:
            unsupported.append("period")

    if dynamic:
        if screen == "0198":
            applied["period"] = str(query["period"])
            unsupported.append("etf")
        elif screen == "0187":
            applied.update({"market": str(query["market"]), "venue": str(query["venue"])})
            unsupported.append("tradingWeight")
        elif screen == "0184":
            applied.update({"market": str(query["market"]), "venue": str(query["venue"]), "sort": str(query["sort"]), "session": str(query["session"]), "stock": str(query["stock"]), "credit": str(query["credit"]), "volumeBand": str(query["volumeBand"]), "priceBand": str(query["priceBand"]), "valueBand": str(query["valueBand"])})
        elif screen == "0186":
            applied.update({"market": str(query["market"]), "venue": str(query["venue"]), "managed": str(query["managed"])})
        elif screen == "0162":
            applied.update({"market": str(query["market"]), "venue": str(query["venue"]), "direction": str(query["direction"]), "limitSort": str(query["limitSort"]), "stock": str(query["stock"]), "credit": str(query["credit"]), "volumeBand": str(query["volumeBand"]), "priceBand": str(query["priceBand"])})
        elif screen in {"0211", "0602"}:
            applied.update({"sector": str(query["sector"]), "interval": str(query["interval"])})
            if screen == "0211":
                applied["venue"] = str(query["venue"])
            if query["end"]:
                applied["end"] = str(query["end"])
            effective_end = str(query["end"] or _day())
        elif screen in {"0780", "2797"}:
            if investor_period_supported:
                applied.update({"market": str(query["market"]), "venue": str(query["venue"]), "unit": str(query["unit"])})
                if query["start"]:
                    applied["start"] = str(query["start"])
                if query["end"]:
                    applied["end"] = str(query["end"])
                if screen == "0780":
                    effective_start = effective_end = _one_base_date(query)
        elif screen == "0700":
            applied["provider"] = str(query["provider"])
            if query["query"]:
                applied["query"] = str(query["query"])

    note = str(payload.get("note") or "")
    if screen == "0187" and "tradingWeight" not in unsupported:
        # The fixture keeps this value null too; it remains unsupported even
        # though no broker-side filters were applied in that environment.
        unsupported.append("tradingWeight")
    if screen == "0198" and "etf" not in unsupported:
        unsupported.append("etf")
    if "Bounded candidate set; not a full-market market-cap ranking." in note:
        limited_reason = "bounded market-cap candidate set"
    elif "10초 뉴스 집계 제한" in note:
        limited_reason = "10-second news aggregation deadline"
    elif "전역 동시 조회 제한" in note:
        limited_reason = "global news aggregation concurrency limit"

    visible = payload.get("news") if screen == "0700" else payload.get("rows")
    returned_rows = len(visible) if isinstance(visible, list) else 0
    return {
        "appliedFilters": applied,
        "effectiveStart": effective_start,
        "effectiveEnd": effective_end,
        "returnedRows": returned_rows,
        "limitedReason": limited_reason,
        "unsupported": unsupported,
    }


def _with_screen_scope(
    screen: str, query: dict[str, str | None], payload: CapturePayload
) -> CapturePayload:
    result = dict(payload)
    result["scope"] = _screen_scope(screen, query, payload)
    return result  # type: ignore[return-value]


def _page(api_id: str, path: str, body: dict[str, str]) -> tuple[dict[str, Any], bool, str]:
    response = gateway._fetch_page(api_id, path, body)
    body = getattr(response, "body", None) or {}
    if not isinstance(body, dict): raise gateway.BrokerError("invalid Kiwoom payload")
    has_next, _, _ = gateway._continuation(response)
    return body, not has_next, "" if not has_next else "최근 응답만 표시하며 추가 과거 자료가 있습니다."


def _rows(api_id: str, path: str, body: dict[str, str], key: str, *, max_pages: int = 5) -> tuple[list[dict[str, Any]], bool, str]:
    rows, complete, note = gateway._fetch_rows(api_id, path, body, key, max_pages=max_pages)
    notes = {
        "continuation key missing": "추가 자료 조회 정보가 없어 수신된 범위만 표시합니다.",
        "continuation key repeated": "추가 자료가 반복되어 수신된 범위만 표시합니다.",
        "continuation page empty": "추가 자료가 비어 있어 수신된 범위만 표시합니다.",
        f"pagination capped at {max_pages} pages": "조회 범위에 제한이 있어 일부 자료만 표시합니다.",
    }
    return rows, complete, notes.get(note, note)


_FIXTURE_INSTRUMENTS = {
    "005930": {"market": "KR", "stkCd": "005930", "stkNm": "삼성전자", "stexTp": "KRX", "listingVenue": "KOSPI", "quoteVenue": "KRX", "currency": "KRW", "environment": "fixture"},
    "000660": {"market": "KR", "stkCd": "000660", "stkNm": "SK하이닉스", "stexTp": "KRX", "listingVenue": "KOSPI", "quoteVenue": "KRX", "currency": "KRW", "environment": "fixture"},
    "247540": {"market": "KR", "stkCd": "247540", "stkNm": "에코프로비엠", "stexTp": "KRX", "listingVenue": "KOSDAQ", "quoteVenue": "KRX", "currency": "KRW", "environment": "fixture"},
}


def _instruments() -> dict[str, dict[str, Any]]:
    if not gateway.KIWOOM_ENABLED: return dict(_FIXTURE_INSTRUMENTS)
    indexed, _, _ = gateway._indexed("KR")
    required = ("market", "stkCd", "stkNm", "stexTp", "listingVenue", "quoteVenue", "currency", "environment")
    return {str(row["stkCd"]): {key: row[key] for key in required} for row in indexed if isinstance(row, dict) and _CODE.fullmatch(str(row.get("stkCd") or "")) and row.get("market") == "KR" and row.get("stexTp") == row.get("quoteVenue") == "KRX" and row.get("listingVenue") in {"KOSPI", "KOSDAQ"} and all(key in row for key in required)}


def _stock_row(raw: dict[str, Any], position: int, instruments: dict[str, dict[str, Any]]) -> dict[str, Any]:
    code = _base_code(raw.get("stk_cd"))
    result: dict[str, Any] = {"id": code if _CODE.fullmatch(code) else f"row-{position}", "code": code or None, "name": _text(raw.get("stk_nm")), "price": _number(raw.get("cur_prc"), absolute=True, price=True), "change": _number(raw.get("pred_pre")), "changePct": _number(raw.get("flu_rt")), "volume": _number(raw.get("trde_qty") if "trde_qty" in raw else raw.get("now_trde_qty"), absolute=True)}
    if code in instruments: result["instrument"] = dict(instruments[code])
    return result


def _selection_pending(rows: list[dict[str, Any]]) -> bool:
    """Only retry identity hydration when an otherwise usable ranking has none."""
    return bool(rows) and not any(isinstance(row.get("instrument"), dict) for row in rows)


_STOCK_COLUMNS: list[Column] = [{"key": "name", "label": "종목명"}, {"key": "price", "label": "현재가", "unit": "KRW", "numeric": True}, {"key": "change", "label": "전일대비", "unit": "KRW", "numeric": True}, {"key": "changePct", "label": "등락률", "unit": "%", "numeric": True}, {"key": "volume", "label": "거래량", "unit": "shares", "numeric": True}]


def _rank(screen: str, query: dict[str, str | None]) -> CapturePayload:
    venue_label = {"ALL": "통합", "KRX": "KRX", "NXT": "NXT"}[str(query["venue"])]
    title = f"{'당일거래상위' if screen == '0184' else '거래대금상위'}({venue_label})"
    if screen == "0184":
        mapping = {"volume": ("1", "volume", "거래량", "shares", "trde_qty"), "turnover": ("2", "turnoverRate", "거래회전율", "%", "trde_tern_rt"), "value": ("3", "tradingValue", "거래대금", "KRW millions", "trde_amt")}
        sort_type, metric, label, unit, raw_metric = mapping[str(query["sort"])]
        api, key = "ka10030", "tdy_trde_qty_upper"
        body = {"mrkt_tp": _MARKETS[str(query["market"])], "sort_tp": sort_type, "mang_stk_incls": _RANK_STOCKS[str(query["stock"])], "crd_tp": _RANK_CREDITS[str(query["credit"])], "trde_qty_tp": _RANK_VOLUMES[str(query["volumeBand"])], "pric_tp": _RANK_PRICES[str(query["priceBand"])], "trde_prica_tp": _RANK_VALUES[str(query["valueBand"])], "mrkt_open_tp": _SESSIONS[str(query["session"])], "stex_tp": _VENUES[str(query["venue"])]}
    else:
        metric, label, unit, raw_metric = "tradingValue", "거래대금", "KRW millions", "trde_prica"
        api, key = "ka10032", "trde_prica_upper"
        body = {"mrkt_tp": _MARKETS[str(query["market"])], "mang_stk_incls": _MANAGED[str(query["managed"])], "stex_tp": _VENUES[str(query["venue"])]}
    if screen == "0184":
        columns = [{"key": "rank", "label": "순위", "numeric": True}, *_STOCK_COLUMNS, {"key": "previousChangePct", "label": "전일비", "unit": "%", "numeric": True}, {"key": "turnoverRate", "label": "회전율", "unit": "%", "numeric": True}, {"key": "tradingValue", "label": "거래금액", "unit": "KRW millions", "numeric": True}]
    else:
        columns = [{"key": "rank", "label": "순위", "numeric": True}, {"key": "previousRank", "label": "전일순위", "numeric": True}, {"key": "name", "label": "종목명"}, {"key": "price", "label": "현재가", "unit": "KRW", "numeric": True}, {"key": "change", "label": "전일대비", "unit": "KRW", "numeric": True}, {"key": "changePct", "label": "등락률", "unit": "%", "numeric": True}, {"key": "sellPrice", "label": "매도호가", "unit": "KRW", "numeric": True}, {"key": "buyPrice", "label": "매수호가", "unit": "KRW", "numeric": True}, {"key": "volume", "label": "현재거래량", "unit": "shares", "numeric": True}, {"key": "previousVolume", "label": "전일거래량", "unit": "shares", "numeric": True}, {"key": "tradingValue", "label": "거래대금", "unit": "KRW millions", "numeric": True}]
    if not gateway.KIWOOM_ENABLED:
        return _fixture(screen, title, columns, [{"id": "005930", "code": "005930", "name": "삼성전자", "price": 71500.0, "change": 500.0, "changePct": 0.7, "volume": 11200000.0, metric: 11200000.0 if metric == "volume" else 2.4 if metric == "turnoverRate" else 800800.0, "instrument": _FIXTURE_INSTRUMENTS["005930"]}])
    raws, complete, note = _rows(api, "/api/dostk/rkinfo", body, key)
    instruments, result = _instruments(), []
    for position, raw in enumerate(raws, 1):
        row = _stock_row(raw, position, instruments)
        row["rank"] = position if screen == "0184" else _number(raw.get("now_rank"), absolute=True) or position
        if screen == "0184":
            row.update({"previousChangePct": _number(raw.get("pred_rt")), "turnoverRate": _number(raw.get("trde_tern_rt"), absolute=True), "tradingValue": _number(raw.get("trde_amt"), absolute=True)})
        else:
            row.update({"previousRank": _number(raw.get("pred_rank"), absolute=True), "sellPrice": _number(raw.get("sel_bid"), absolute=True, price=True), "buyPrice": _number(raw.get("buy_bid"), absolute=True, price=True), "previousVolume": _number(raw.get("pred_trde_qty"), absolute=True), "tradingValue": _number(raw.get("trde_prica"), absolute=True)})
        result.append(row)
    pending = _selection_pending(result)
    pending_note = " 종목 선택 정보가 준비 중이며 잠시 후 다시 확인합니다." if pending else ""
    return _payload(screen, title, source="kiwoom", status="snapshot" if result else "missing", note=(note or "키움 순위 조회 · 시장 기준시각은 응답에 포함되지 않습니다.") + pending_note, complete=bool(complete and result), columns=columns, rows=result, selection_pending=pending)


def _screen_0198(query: dict[str, str | None]) -> CapturePayload:
    title = "실시간종목조회순위"
    query_type = str(query["period"])
    columns: list[Column] = [{"key": "rank", "label": "조회순위", "numeric": True}, {"key": "name", "label": "종목명"}, {"key": "rankChange", "label": "순위등락", "numeric": True}, {"key": "price", "label": "기준시점 주가", "unit": "KRW", "numeric": True}, {"key": "changePct", "label": "기준가 대비 등락률", "unit": "%", "numeric": True}, {"key": "previousChangePct", "label": "직전 기준 대비 등락률", "unit": "%", "numeric": True}, {"key": "asOf", "label": "기준시각"}]
    if not gateway.KIWOOM_ENABLED:
        return _fixture("0198", title, columns, [{"id": "005930", "name": "삼성전자", "rank": 1, "rankChange": 0, "price": 71500.0, "changePct": 0.7, "previousChangePct": 0.1, "asOf": "20261024 090000", "instrument": _FIXTURE_INSTRUMENTS["005930"]}])
    raws, complete, note = _rows("ka00198", "/api/dostk/stkinfo", {"qry_tp": query_type}, "item_inq_rank")
    instruments, result = _instruments(), []
    for position, raw in enumerate(raws, 1):
        code = str(raw.get("stk_cd") or "").strip().upper()
        row: dict[str, Any] = {"id": code if _CODE.fullmatch(code) else f"rank-{position}", "code": code or None, "name": _text(raw.get("stk_nm")), "rank": _number(raw.get("bigd_rank"), absolute=True) or position, "rankChange": _number(raw.get("rank_chg")), "rankChangeSign": _text(raw.get("rank_chg_sign")), "price": _number(raw.get("past_curr_prc"), absolute=True, price=True), "changePct": _number(raw.get("base_comp_chgr")), "previousChangePct": _number(raw.get("prev_base_chgr")), "asOf": " ".join(part for part in (_text(raw.get("dt")), _text(raw.get("tm"))) if part)}
        if code in instruments: row["instrument"] = dict(instruments[code])
        result.append(row)
    pending = _selection_pending(result)
    pending_note = " 종목 선택 정보가 준비 중이며 잠시 후 다시 확인합니다." if pending else ""
    return _payload("0198", title, source="kiwoom", status="snapshot" if result else "missing", note=(note or "키움 종목 조회순위 · 각 행의 기준시각을 확인하세요.") + pending_note, complete=bool(complete and result), columns=columns, rows=result, selection_pending=pending)


def _screen_0162(query: dict[str, str | None]) -> CapturePayload:
    venue_label = {"ALL": "통합", "KRX": "KRX", "NXT": "NXT"}[str(query["venue"])]
    title = f"상하한가({venue_label})"
    columns = [{"key": "name", "label": "종목명"}, {"key": "price", "label": "현재가", "unit": "KRW", "numeric": True}, {"key": "change", "label": "전일대비", "unit": "KRW", "numeric": True}, {"key": "changePct", "label": "등락률", "unit": "%", "numeric": True}, {"key": "volume", "label": "거래량", "unit": "shares", "numeric": True}, {"key": "previousVolume", "label": "전일거래량", "unit": "shares", "numeric": True}, {"key": "sellQuantity", "label": "매도잔량", "unit": "shares", "numeric": True}, {"key": "sellPrice", "label": "매도호가", "unit": "KRW", "numeric": True}, {"key": "buyPrice", "label": "매수호가", "unit": "KRW", "numeric": True}, {"key": "buyQuantity", "label": "매수잔량", "unit": "shares", "numeric": True}, {"key": "count", "label": "연속횟수", "numeric": True}]
    selected = {"up": "1", "rise": "2", "flat": "3", "down": "4", "fall": "5", "previousUpLimit": "6", "previousDownLimit": "7"}[str(query["direction"])]
    if not gateway.KIWOOM_ENABLED:
        return _fixture("0162", title, columns, [{"id": "005930", "code": "005930", "name": "삼성전자", "price": 71500.0, "change": 500.0, "changePct": 0.7, "volume": 11200000.0, "previousVolume": 11000000.0, "count": 0, "instrument": _FIXTURE_INSTRUMENTS["005930"]}])
    body = {"mrkt_tp": _MARKETS[str(query["market"])], "updown_tp": selected, "sort_tp": _LIMIT_SORTS[str(query["limitSort"])], "stk_cnd": _LIMIT_STOCKS[str(query["stock"])], "trde_qty_tp": _LIMIT_VOLUMES[str(query["volumeBand"])], "crd_cnd": _LIMIT_CREDITS[str(query["credit"])], "trde_gold_tp": _LIMIT_PRICES[str(query["priceBand"])], "stex_tp": _VENUES[str(query["venue"])]}
    raws, complete, note = _rows("ka10017", "/api/dostk/stkinfo", body, "updown_pric")
    instruments, result = _instruments(), []
    for position, raw in enumerate(raws, 1):
        row = _stock_row(raw, position, instruments)
        row.update({"previousVolume": _number(raw.get("pred_trde_qty"), absolute=True), "sellQuantity": _number(raw.get("sel_req"), absolute=True), "sellPrice": _number(raw.get("sel_bid"), absolute=True, price=True), "buyPrice": _number(raw.get("buy_bid"), absolute=True, price=True), "buyQuantity": _number(raw.get("buy_req"), absolute=True), "count": _number(raw.get("cnt"), absolute=True)})
        result.append(row)
    pending = _selection_pending(result)
    pending_note = " 종목 선택 정보가 준비 중이며 잠시 후 다시 확인합니다." if pending else ""
    return _payload("0162", title, source="kiwoom", status="snapshot" if result else "missing", note=(note or "키움 상·하한가 조회 · 시장 기준시각은 응답에 포함되지 않습니다.") + pending_note, complete=bool(complete and result), columns=columns, rows=result, selection_pending=pending)


def _sector_market(sector: str) -> str | None:
    if sector in {"001", "002", "003", "004", "701"}: return "0"
    if sector in {"101", "302"}: return "1"
    if sector == "201": return "2"
    return None


def _resolve_sector_market(sector: str) -> str | None:
    known = _sector_market(sector)
    if known is not None or not gateway.KIWOOM_ENABLED:
        return known
    # Discover the listing from the provider's industry lists instead of
    # assuming a market from an undocumented numeric range.
    for index, market in (("001", "0"), ("101", "1")):
        rows, _, _ = _rows("ka20003", "/api/dostk/sect", {"inds_cd": index}, "all_inds_idex")
        if any(_base_code(row.get("stk_cd")) == sector for row in rows):
            return market
    return None


_SECTOR_COLUMNS: list[Column] = [{"key": "name", "label": "업종명"}, {"key": "index", "label": "업종지수", "unit": "index", "numeric": True}, {"key": "change", "label": "전일대비", "unit": "index", "numeric": True}, {"key": "changePct", "label": "등락률", "unit": "%", "numeric": True}, {"key": "volume", "label": "거래량", "unit": "thousand shares", "numeric": True}, {"key": "tradingValue", "label": "거래대금", "unit": "KRW millions", "numeric": True}]


def _summary(raw: dict[str, Any], sector: str) -> dict[str, Any]:
    return {"id": f"sector:{sector}", "name": "업종현재가", "sectorCode": sector, "index": _number(raw.get("cur_prc"), absolute=True, price=True), "change": _number(raw.get("pred_pre")), "changePct": _number(raw.get("flu_rt")), "volume": _number(raw.get("trde_qty"), absolute=True), "tradingValue": _number(raw.get("trde_prica"), absolute=True), "open": _number(raw.get("open_pric"), absolute=True, price=True), "high": _number(raw.get("high_pric"), absolute=True, price=True), "low": _number(raw.get("low_pric"), absolute=True, price=True), "rising": _number(raw.get("rising"), absolute=True), "falling": _number(raw.get("fall"), absolute=True), "flat": _number(raw.get("stdns"), absolute=True)}


def _daily(raw: dict[str, Any], sector: str) -> list[dict[str, Any]]:
    result = []
    values = raw.get("inds_cur_prc_daly_rept")
    for item in values if isinstance(values, list) else []:
        date = str(item.get("dt_n") or "") if isinstance(item, dict) else ""
        if not re.fullmatch(r"[0-9]{8}", date): continue
        result.append({"id": f"{sector}:{date}", "date": date, "index": _number(item.get("cur_prc_n"), absolute=True, price=True), "change": _number(item.get("pred_pre_n")), "changePct": _number(item.get("flu_rt_n")), "volume": _number(item.get("acc_trde_qty_n"), absolute=True)})
    return result


def _section(identifier: str, title: str, columns: list[Column], rows: list[dict[str, Any]], *, status: str = "snapshot", note: str = "") -> Section:
    return {"id": identifier, "title": title, "columns": columns, "rows": _fill_cells(rows, columns), "source": "kiwoom", "status": status, "asOf": None, "note": note or "키움 조회 자료 · 시장 기준시각 미제공"}


def _industry_bars(sector: str, interval: str, base_date: str) -> tuple[list[dict[str, Any]], bool, str]:
    """The five official industry chart APIs document OHLC as scaled by 100."""
    api, key = {"D": ("ka20006", "inds_dt_pole_qry"), "W": ("ka20007", "inds_stk_pole_qry"), "M": ("ka20008", "inds_mth_pole_qry"), "Y": ("ka20019", "inds_yr_pole_qry")}.get(interval, ("ka20005", "inds_min_pole_qry"))
    body = {"inds_cd": sector, "base_dt": base_date}
    if api == "ka20005": body["tic_scope"] = interval
    raws, complete, note = _rows(api, "/api/dostk/chart", body, key)
    result = []
    for raw in raws:
        stamp = str(raw.get("dt") or "").strip()
        if api == "ka20005":
            clock = str(raw.get("cntr_tm") or "").strip()
            # A full exchange date is required: the request date can differ
            # from returned trading dates (holidays and continuation pages).
            stamp = clock if re.fullmatch(r"[0-9]{14}", clock) else f"{stamp}{clock}" if re.fullmatch(r"[0-9]{8}", stamp) and re.fullmatch(r"[0-9]{6}", clock) else ""
        values = [_number(raw.get(key), absolute=True, price=True) for key in ("open_pric", "high_pric", "low_pric", "cur_prc")]
        if not re.fullmatch(r"[0-9]{14}" if api == "ka20005" else r"[0-9]{8}", stamp) or any(value is None for value in values): continue
        opening, high, low, close = (value / 100 for value in values if value is not None)
        result.append({"t": stamp, "o": opening, "h": high, "l": low, "c": close, "v": _number(raw.get("trde_qty"), absolute=True)})
    return result, complete, note


def _screen_0211(query: dict[str, str | None]) -> CapturePayload:
    title, sector = "업종현재가", str(query["sector"])
    market = _resolve_sector_market(sector)
    if market is None: return _missing("0211", title, "This industry code has no verified ka20001 market binding.")
    if not gateway.KIWOOM_ENABLED:
        return _fixture("0211", title, _SECTOR_COLUMNS, [{"id": "sector:001", "name": "업종현재가", "sectorCode": "001", "index": 2700.0, "change": 18.5, "changePct": 0.69, "volume": 450000.0, "tradingValue": 870000.0}])
    try:
        summary_raw, complete, summary_note = _page("ka20001", "/api/dostk/sect", {"mrkt_tp": market, "inds_cd": sector})
    except gateway.BrokerError:
        return _payload("0211", title, source="kiwoom", status="error", note="키움 업종 요약을 받지 못했습니다.", complete=False)
    sections, notes = [], [summary_note] if summary_note else []
    times = summary_raw.get("inds_cur_prc_tm")
    time_rows = []
    for item in times if isinstance(times, list) else []:
        if not isinstance(item, dict): continue
        stamp = str(item.get("tm_n") or "").strip()
        if not re.fullmatch(r"[0-9]{6}", stamp): continue
        time_rows.append({"id": stamp, "time": f"{stamp[:2]}:{stamp[2:4]}:{stamp[4:]}", "index": _number(item.get("cur_prc_n"), absolute=True), "change": _number(item.get("pred_pre_n")), "changePct": _number(item.get("flu_rt_n")), "volume": _number(item.get("trde_qty_n"), absolute=True), "accVolume": _number(item.get("acc_trde_qty_n"), absolute=True)})
    sections.append(_section("time", "시간대별", [{"key": "time", "label": "시간"}, *_SECTOR_COLUMNS[1:5], {"key": "accVolume", "label": "누적거래량", "numeric": True, "unit": "thousand shares"}], time_rows, note="키움 제공 시간대별 지수 · 거래일은 응답에 포함되지 않습니다. " + summary_note))
    try:
        raws, partial, note = _rows("ka20002", "/api/dostk/sect", {"mrkt_tp": market, "inds_cd": sector, "stex_tp": _VENUES[str(query["venue"])]}, "inds_stkpc")
        sections.append(_section("components", "업종 구성종목", _STOCK_COLUMNS, [_stock_row(raw, pos, _instruments()) for pos, raw in enumerate(raws, 1)], note=note)); complete &= partial
        if note: notes.append(note)
    except gateway.BrokerError:
        sections.append(_section("components", "업종 구성종목", _STOCK_COLUMNS, [], status="error", note="구성종목 시세를 받지 못했습니다.")); complete = False
    try:
        raws, partial, note = _rows("ka20003", "/api/dostk/sect", {"inds_cd": "101" if market == "1" else "001"}, "all_inds_idex")
        rows = [{"id": str(raw.get("stk_cd") or f"industry-{pos}"), "name": _text(raw.get("stk_nm")), "sectorCode": _text(raw.get("stk_cd")), "index": _number(raw.get("cur_prc"), absolute=True, price=True), "change": _number(raw.get("pred_pre")), "changePct": _number(raw.get("flu_rt")), "volume": _number(raw.get("trde_qty"), absolute=True), "tradingValue": _number(raw.get("trde_prica"), absolute=True)} for pos, raw in enumerate(raws, 1)]
        sections.append(_section("all-industries", "전업종지수", _SECTOR_COLUMNS, rows, note=note)); complete &= partial
        if note: notes.append(note)
    except gateway.BrokerError:
        sections.append(_section("all-industries", "전업종지수", _SECTOR_COLUMNS, [], status="error", note="전업종 지수를 받지 못했습니다.")); complete = False
    try:
        raw, partial, note = _page("ka20009", "/api/dostk/sect", {"mrkt_tp": market, "inds_cd": sector})
        cols = [{"key": "date", "label": "일자"}, {"key": "index", "label": "종가 지수", "unit": "index", "numeric": True}, {"key": "change", "label": "전일대비", "unit": "index", "numeric": True}, {"key": "changePct", "label": "등락률", "unit": "%", "numeric": True}, {"key": "volume", "label": "누적거래량", "unit": "thousand shares", "numeric": True}]
        sections.append(_section("daily", "업종 일별", cols, _daily(raw, sector), note=note or "키움 일별 종가 자료")); complete &= partial
        if note: notes.append(note)
    except gateway.BrokerError:
        sections.append(_section("daily", "업종 일별", [], [], status="error", note="업종 일별 시세를 받지 못했습니다.")); complete = False
    bars: list[dict[str, Any]] = []
    try:
        bars, partial, note = _industry_bars(sector, str(query["interval"]), str(query["end"] or _day())); complete &= partial
        if note: notes.append(note)
    except gateway.BrokerError:
        notes.append("Kiwoom industry chart feed is unavailable"); complete = False
    summary = _summary(summary_raw, sector)
    return _payload("0211", title, source="kiwoom", status="snapshot" if summary["index"] is not None else "missing", note="; ".join(dict.fromkeys(notes)) or "키움 업종 시세 · 시장 기준시각은 응답에 포함되지 않습니다.", complete=bool(complete), columns=_SECTOR_COLUMNS, rows=[summary], sections=sections, bars=bars)


def _screen_0602(query: dict[str, str | None]) -> CapturePayload:
    title, sector = "업종차트", str(query["sector"])
    columns = [{"key": "date", "label": "일자"}, {"key": "index", "label": "종가 지수", "unit": "index", "numeric": True}]
    if not gateway.KIWOOM_ENABLED:
        bars = [{"t": "20261024", "o": 2680.0, "h": 2710.0, "l": 2670.0, "c": 2700.0, "v": 450000.0}]
        return _payload("0602", title, source="fixture", status="fixture", note="Deterministic fixture/test OHLC data; no upstream request was made.", complete=True, columns=columns, rows=[{"id": "001:20261024", "date": "20261024", "index": 2700.0}], bars=bars, as_of="2026-10-24")
    try:
        bars, complete, note = _industry_bars(sector, str(query["interval"]), str(query["end"] or _day()))
    except gateway.BrokerError:
        return _payload("0602", title, source="kiwoom", status="error", note="업종 차트 데이터를 받지 못했습니다.", complete=False, columns=columns, bars=[])
    rows = [{"id": f"{sector}:{bar['t']}", "date": bar["t"], "index": bar["c"]} for bar in bars]
    return _payload("0602", title, source="kiwoom", status="snapshot" if bars else "missing", note=note or "Official industry OHLC data; index values divided by 100 per official specification.", complete=bool(complete and bars), columns=columns, rows=rows, bars=bars)


_INVESTOR_COLUMNS: list[Column] = [{"key": "market", "label": "시장"}, {"key": "sector", "label": "업종"}, {"key": "price", "label": "현재가", "unit": "KRW", "numeric": True}, {"key": "change", "label": "전일대비", "unit": "KRW", "numeric": True}, {"key": "changePct", "label": "등락률", "unit": "%", "numeric": True}, {"key": "individual", "label": "개인 순매수", "numeric": True}, {"key": "foreign", "label": "외국인 순매수", "numeric": True}, {"key": "institutional", "label": "기관계 순매수", "numeric": True}]


def _investor_row(raw: dict[str, Any], market: str, unit: str, date: str) -> dict[str, Any]:
    code = _base_code(raw.get("inds_cd"))
    # ka10051 encodes index, index change and percentage in hundredths.
    # Official examples and real ka20001/ka20003 cross-check agree (555030 ->
    # 5550.30; 1653 -> 16.53; 30 -> 0.30 on 2026-10-24).
    scaled = lambda field: None if (value := _number(raw.get(field))) is None else value / 100
    return {"id": f"{market}:{code}:{date}", "market": market, "sectorCode": code or None, "sector": _text(raw.get("inds_nm")), "price": abs(scaled("cur_prc")) if scaled("cur_prc") is not None else None, "change": scaled("pred_pre"), "changePct": scaled("flu_rt"), "individual": _number(raw.get("ind_netprps")), "foreign": _number(raw.get("frgnr_netprps")), "institutional": _number(raw.get("orgn_netprps")), "securities": _number(raw.get("sc_netprps")), "insurance": _number(raw.get("insrnc_netprps")), "investmentTrust": _number(raw.get("invtrt_netprps")), "bank": _number(raw.get("bank_netprps")), "pension": _number(raw.get("jnsinkm_netprps")), "fund": _number(raw.get("endw_netprps")), "otherCorporation": _number(raw.get("etc_corp_netprps")), "privateFund": _number(raw.get("samo_fund_netprps")), "national": _number(raw.get("natn_netprps")), "nativeTrmtForeign": _number(raw.get("native_trmt_frgnr_netprps")), "unit": unit}


def _investor_screen(screen: str, query: dict[str, str | None]) -> CapturePayload:
    title = "투자자별매매종합" if screen == "0780" else "업종별 투자자 기준일 순매수"
    if not _investor_period_is_supported(query):
        return _missing(screen, title, "ka10051 is verified for one base date only; multi-day period semantics are unsupported and no repeated snapshots are summed.")
    date, amount = _one_base_date(query), query["unit"] == "amount"
    unit = "KRW 100m" if amount else "thousand shares"
    columns = [dict(column) for column in _INVESTOR_COLUMNS]
    for column in columns:
        if column["key"] in {"price", "change"}: column["unit"] = "index"
        if column["key"] in {"individual", "foreign", "institutional"}: column["unit"] = unit
    columns.extend({"key": key, "label": label, "numeric": True, "unit": unit} for key, label in [("securities", "금융투자"), ("insurance", "보험"), ("investmentTrust", "투신"), ("bank", "은행"), ("pension", "종금"), ("fund", "연기금"), ("privateFund", "사모펀드"), ("national", "국가"), ("otherCorporation", "기타법인"), ("nativeTrmtForeign", "내국인대우 외국인")])
    selected = [str(query["market"])] if query["market"] != "all" else ["KOSPI", "KOSDAQ"]
    if not gateway.KIWOOM_ENABLED:
        return _fixture(screen, title, columns, [{"id": f"KOSPI:001:{date}", "market": "KOSPI", "sectorCode": "001", "sector": "KOSPI", "price": 2700.0, "change": 18.5, "changePct": 0.69, "individual": -125.0, "foreign": 101.0, "institutional": 24.0, "unit": unit}], "Deterministic fixture/test one-day industry investor data; no upstream request was made.")
    result, notes, complete = [], [], True
    successful_markets, failed_markets = 0, []
    for market in selected:
        try:
            raws, partial, note = _rows("ka10051", "/api/dostk/sect", {"mrkt_tp": "0" if market == "KOSPI" else "1", "amt_qty_tp": "0" if amount else "1", "base_dt": date, "stex_tp": _VENUES[str(query["venue"])]}, "inds_netprps")
            successful_markets += 1
            code = "001" if market == "KOSPI" else "101"
            if screen == "2797":
                seen: set[str] = set()
                for raw in raws:
                    sector_code = _base_code(raw.get("inds_cd"))
                    if not sector_code or sector_code in seen: continue
                    seen.add(sector_code)
                    result.append(_investor_row(raw, market, unit, date))
                if len(seen) != len(raws): notes.append(f"{market} duplicate industry rows were retained only once")
                complete &= bool(partial and seen)
            else:
                total_rows = [row for row in raws if _base_code(row.get("inds_cd")) == code]
                if total_rows: result.append(_investor_row(total_rows[0], market, unit, date))
                else: notes.append(f"{market} overall row was absent; no sector sum was substituted")
                if len(total_rows) > 1: notes.append(f"{market} duplicate overall rows were not summed")
                complete &= bool(partial and len(total_rows) == 1)
            if note: notes.append(note)
        except gateway.BrokerError:
            failed_markets.append(market)
            notes.append(f"{market} investor feed is unavailable"); complete = False
    if failed_markets and successful_markets:
        notes.append("일부 시장 투자자 자료를 받지 못해 수신 결과가 완전하지 않습니다.")
    elif failed_markets:
        notes.append("요청한 모든 시장의 투자자 자료를 받지 못했습니다.")
    elif successful_markets and not result:
        notes.append("키움 응답은 성공했지만 조회 조건에 해당하는 행이 없습니다.")
    status = "error" if failed_markets and not successful_markets else "snapshot" if result else "missing"
    return _payload(screen, title, source="kiwoom", status=status, note="; ".join(dict.fromkeys(notes)) or f"조회 기준일 {date} · 키움 제공 순매수. 휴장일의 최종 집계 거래일은 응답에서 확인되지 않습니다.", complete=bool(complete and result), columns=columns, rows=result, as_of=None)


_CAP_LOCK = Lock()
_CAP_LIMIT, _CAP_BATCH, _CAP_TTL = 10_000, 50, 60.0
_CAP_MAX_STATES = 6
_CAP_WORKER_LOCK = Lock()
_CAPS: dict[tuple[Any, ...], dict[str, Any]] = {}
_CAP_QUEUE: deque[tuple[tuple[Any, ...], str, list[str], dict[str, dict[str, Any]]]] = deque()
_CAP_SCHEDULER_RUNNING = False


def _idle_cap_states_locked() -> None:
    """Evict only completed states, never an active/coalesced collection."""
    while len(_CAPS) >= _CAP_MAX_STATES:
        idle = [(float(state["finished"] or 0), key) for key, state in _CAPS.items() if not state["running"]]
        if not idle:
            return
        _, key = min(idle)
        del _CAPS[key]


def _start_cap_scheduler_locked() -> None:
    global _CAP_SCHEDULER_RUNNING
    if _CAP_SCHEDULER_RUNNING:
        return
    _CAP_SCHEDULER_RUNNING = True
    Thread(target=_run_cap_queue, name="kiwoom-market-cap", daemon=True).start()


def _cap_state(key: tuple[Any, ...], environment: str, universe: int, requested: int) -> dict[str, Any]:
    return {"key": key, "environment": environment, "universe": universe, "requested": requested, "queried": 0, "rows": {}, "snapshot_rows": {}, "snapshot_finished": 0.0, "snapshot_received_at": None, "snapshot_complete": False, "running": True, "done": False, "note": "", "finished": 0.0}


def _queue_cap_collection(key: tuple[Any, ...], environment: str, codes: list[str], instruments: dict[str, dict[str, Any]], universe: int) -> dict[str, Any] | None:
    """Return a coalesced state or enqueue one bounded, serial collection."""
    now = time.monotonic()
    with _CAP_LOCK:
        state = _CAPS.get(key)
        if state is not None:
            expired = not state["running"] and now - float(state["finished"] or 0) >= _CAP_TTL
            if not expired:
                return dict(state)
            # Keep the exact-query snapshot while its successor collects. The
            # in-progress rows stay separate, so no partially refreshed table
            # can be mixed with the prior completed ranking.
            state.update({"queried": 0, "rows": {}, "running": True, "done": False, "note": "", "finished": 0.0})
            _CAP_QUEUE.append((key, environment, codes, instruments))
            _start_cap_scheduler_locked()
            return dict(state)
        _idle_cap_states_locked()
        if len(_CAPS) >= _CAP_MAX_STATES:
            return None
        state = _cap_state(key, environment, universe, len(codes))
        _CAPS[key] = state
        _CAP_QUEUE.append((key, environment, codes, instruments))
        _start_cap_scheduler_locked()
        return dict(state)


def _run_cap_queue() -> None:
    """One bounded scheduler preserves the broker's serial market-cap budget."""
    global _CAP_SCHEDULER_RUNNING
    try:
        with _CAP_WORKER_LOCK:
            while True:
                with _CAP_LOCK:
                    if not _CAP_QUEUE:
                        return
                    key, environment, codes, instruments = _CAP_QUEUE.popleft()
                    state = _CAPS.get(key)
                    if state is None or not state["running"]:
                        continue
                try:
                    _collect_caps(key, environment, codes, instruments)
                except Exception:
                    # A worker failure must not leave a coalesced query loading
                    # forever or prevent the next bounded job from running.
                    with _CAP_LOCK:
                        state = _CAPS.get(key)
                        if state is not None and state["running"]:
                            state.update({"running": False, "done": False, "note": "시가총액 수집이 중단되어 일부 종목만 표시합니다.", "finished": time.monotonic()})
    finally:
        with _CAP_LOCK:
            _CAP_SCHEDULER_RUNNING = False
            # A request may append after this worker observed an empty queue
            # but before its finally block runs. Start its successor while
            # holding the state lock so no queued query is stranded.
            if _CAP_QUEUE:
                _start_cap_scheduler_locked()


def _collect_caps(key: tuple[Any, ...], environment: str, codes: list[str], instruments: dict[str, dict[str, Any]]) -> None:
    rows: dict[str, dict[str, Any]] = {}
    queried, note, failed = 0, "", False
    try:
        for offset in range(0, len(codes), _CAP_BATCH):
            with _CAP_LOCK:
                state = _CAPS.get(key)
                if state is None or not state["running"]:
                    return
            batch = codes[offset : offset + _CAP_BATCH]
            source, _, reason = _rows("ka10095", "/api/dostk/stkinfo", {"stk_cd": "|".join(batch)}, "atn_stk_infr", max_pages=1)
            queried += len(batch)
            if reason: note = reason
            for position, raw in enumerate(source, 1):
                code = str(raw.get("stk_cd") or "").strip().upper()
                base = code.split("_", 1)[0]
                if base not in instruments or code in rows: continue
                row = _stock_row({**raw, "stk_cd": base}, position, instruments)
                row["id"], row["code"] = code, code
                # A row can link to the separately labelled KRX instrument;
                # it does not relabel this venue's quote as a KRX quote.
                row.update({"marketCap": _number(raw.get("mac"), absolute=True), "tradingWeight": None, "marketCapWeight": None, "tradingStrength": _number(raw.get("cntr_str"), absolute=True)})
                rows[code] = row
            with _CAP_LOCK:
                state = _CAPS.get(key)
                if state is not None and state["running"]:
                    state.update({"queried": queried, "rows": dict(rows)})
    except gateway.BrokerError:
        failed = True
        note = "시가총액 수집이 중단되어 일부 종목만 표시합니다."
    except Exception:
        failed = True
        note = "시가총액 수집 중 응답을 처리하지 못해 일부 종목만 표시합니다."
    finally:
        with _CAP_LOCK:
            state = _CAPS.get(key)
            if state is not None and state["running"]:
                completed = not failed and queried == len(codes)
                covered = sum(1 for row in rows.values() if row.get("marketCap") is not None)
                complete_snapshot = completed and not note and covered == len(codes) == state["universe"]
                update: dict[str, Any] = {"queried": queried, "rows": rows, "running": False, "done": complete_snapshot, "note": note, "finished": time.monotonic()}
                if complete_snapshot:
                    update.update({"snapshot_rows": dict(rows), "snapshot_finished": time.monotonic(), "snapshot_received_at": _now(), "snapshot_complete": True})
                state.update(update)


def _screen_0187(query: dict[str, str | None]) -> CapturePayload:
    venue = str(query["venue"])
    venue_label = {"ALL": "통합", "KRX": "KRX", "NXT": "NXT"}[venue]
    title = f"시가총액상위({venue_label})"
    columns = [{"key": "rank", "label": "순위", "numeric": True}, {"key": "name", "label": "종목명"}, {"key": "price", "label": "현재가", "unit": "KRW", "numeric": True}, {"key": "change", "label": "전일대비", "unit": "KRW", "numeric": True}, {"key": "changePct", "label": "등락률", "unit": "%", "numeric": True}, {"key": "volume", "label": "거래량", "unit": "shares", "numeric": True}, {"key": "tradingWeight", "label": "거래비중", "unit": "%", "numeric": True}, {"key": "marketCap", "label": "시가총액(억원)", "unit": "KRW 100m", "numeric": True}, {"key": "marketCapWeight", "label": "시가총액비", "unit": "%", "numeric": True}, {"key": "tradingStrength", "label": "체결강도", "unit": "%", "numeric": True}]
    if not gateway.KIWOOM_ENABLED:
        return _fixture("0187", title, columns, [{"id": "005930", "rank": 1, "code": "005930", "name": "삼성전자", "price": 71500.0, "change": 500.0, "changePct": 0.7, "volume": 11200000.0, "tradingWeight": None, "marketCap": 4270000.0, "marketCapWeight": None, "tradingStrength": 102.0, "instrument": _FIXTURE_INSTRUMENTS["005930"]}], "거래비중은 산식이 확인되지 않아 표시하지 않습니다.")
    instruments = _instruments()
    selected_market = str(query["market"])
    if selected_market != "all":
        instruments = {code: item for code, item in instruments.items() if item.get("listingVenue") == selected_market}
    if not instruments: return _payload("0187", title, source="kiwoom", status="delayed", note="국내 종목 목록을 준비한 뒤 시가총액을 수집합니다.", complete=False, columns=columns, rows=[])
    env, base_codes = str(gateway.ENVIRONMENT), sorted(instruments)[:_CAP_LIMIT]
    suffix = {"KRX": "", "NXT": "_NX", "ALL": "_AL"}[venue]
    codes = [f"{code}{suffix}" for code in base_codes]
    cache_key = (env, venue, tuple(base_codes))
    scheduled = _queue_cap_collection(cache_key, env, codes, instruments, len(instruments))
    if scheduled is None:
        return _payload("0187", title, source="kiwoom", status="delayed", note="시가총액 수집 대기열이 가득 차 현재 조회 조건은 대기 중입니다. 잠시 후 다시 조회하세요. · 거래비중은 산식이 확인되지 않아 표시하지 않습니다.", complete=False, columns=columns, rows=[])
    state = scheduled
    snapshot_rows = state.get("snapshot_rows") or {}
    has_snapshot = bool(snapshot_rows)
    snapshot_received_at = state.get("snapshot_received_at") if has_snapshot else None
    visible_rows = snapshot_rows if has_snapshot else state["rows"]
    rows = [dict(row) for row in sorted(visible_rows.values(), key=lambda item: (item.get("marketCap") is None, -(item.get("marketCap") or 0), item["id"]))]
    for rank, row in enumerate(rows, 1): row["rank"] = rank
    covered = sum(1 for row in rows if row.get("marketCap") is not None)
    snapshot_complete = bool(state.get("snapshot_complete"))
    full_coverage = bool(has_snapshot and snapshot_complete and state["done"] and not state["note"])
    if snapshot_complete:
        total_cap = sum(row["marketCap"] for row in rows)
        for row in rows:
            row["marketCapWeight"] = row["marketCap"] / total_cap * 100 if total_cap else None
    note = f"대상 {state['universe']:,}종목 · 조회 {state['queried']:,}종목 · 시가총액 수신 {covered:,}종목"
    if state["requested"] < state["universe"]: note += " Bounded candidate set; not a full-market market-cap ranking."
    stale_snapshot = has_snapshot and (state["running"] or not state["done"])
    if stale_snapshot:
        if state["running"]:
            note += f" · 이전 완료 자료 · 수집 완료 {snapshot_received_at or '시각 미상'} · 갱신 수집 {state['queried']:,}/{state['requested']:,}"
        else:
            note += f" · 이전 완료 자료 · 수집 완료 {snapshot_received_at or '시각 미상'} · 갱신 실패"
    elif state["running"]:
        note += " · 수집 중"
    if state["note"]: note += f" {state['note']}"
    note += " · 거래비중은 산식이 확인되지 않아 표시하지 않습니다."
    status = "delayed" if state["running"] or stale_snapshot else "snapshot" if rows else "missing"
    coverage = _section("coverage", "수집 범위", [{"key": "requested", "label": "요청 종목수", "numeric": True}, {"key": "universe", "label": "검증 종목수", "numeric": True}, {"key": "received", "label": "시가총액 수신", "numeric": True}], [{"id": "coverage", "requested": state["requested"], "universe": state["universe"], "received": covered}], status="delayed" if state["running"] or stale_snapshot else "snapshot", note=note)
    return _payload("0187", title, source="kiwoom", status=status, note=note, complete=full_coverage, columns=columns, rows=rows, sections=[coverage], as_of=None, received_at=snapshot_received_at)


def _screen_0200(_query: dict[str, str | None]) -> CapturePayload:
    title = "시장종합"
    columns = [{"key": "name", "label": "지수명"}, {"key": "index", "label": "지수", "unit": "index", "numeric": True}, {"key": "change", "label": "전일대비", "unit": "index", "numeric": True}, {"key": "changePct", "label": "등락률", "unit": "%", "numeric": True}, {"key": "volume", "label": "거래량", "unit": "thousand shares", "numeric": True}, {"key": "tradingValue", "label": "거래대금", "unit": "KRW millions", "numeric": True}]
    if not gateway.KIWOOM_ENABLED:
        return _fixture("0200", title, columns, [{"id": "001", "name": "KOSPI", "index": 2700.0, "change": 18.5, "changePct": 0.69, "volume": 450000.0, "tradingValue": 870000.0}, {"id": "101", "name": "KOSDAQ", "index": 850.0, "change": -3.2, "changePct": -0.38, "volume": 320000.0, "tradingValue": 210000.0}])
    rows, notes, complete = [], [], True
    for code in ("001", "101"):
        try:
            source, partial, note = _rows("ka20003", "/api/dostk/sect", {"inds_cd": code}, "all_inds_idex")
            seen: set[str] = set()
            for position, raw in enumerate(source, 1):
                identity = str(raw.get("stk_cd") or f"{code}-{position}")
                if identity in seen: continue
                seen.add(identity)
                rows.append({"id": identity, "sectorCode": identity, "name": _text(raw.get("stk_nm")), "index": _number(raw.get("cur_prc"), absolute=True, price=True), "change": _number(raw.get("pred_pre")), "changePct": _number(raw.get("flu_rt")), "volume": _number(raw.get("trde_qty"), absolute=True), "tradingValue": _number(raw.get("trde_prica"), absolute=True), "rising": _number(raw.get("rising"), absolute=True), "falling": _number(raw.get("fall"), absolute=True), "flat": _number(raw.get("stdns"), absolute=True)})
            complete &= partial
            if note: notes.append(note)
        except gateway.BrokerError:
            complete = False; notes.append(f"{code} domestic index feed is unavailable")
    for code, label, market in (("201", "KOSPI 200", "2"), ("701", "KRX 100", "0")):
        try:
            raw, partial, note = _page("ka20001", "/api/dostk/sect", {"mrkt_tp": market, "inds_cd": code})
            row = _summary(raw, code)
            row.update(id=code, name=label)
            rows.append(row)
            if row["index"] is None: complete = False
        except gateway.BrokerError:
            complete = False; notes.append(f"{label} 지수 미수신")
    priorities = {code: position for position, code in enumerate(("001", "201", "101", "150", "701", "603"))}
    rows = sorted((row for row in rows if row["id"] in priorities), key=lambda row: priorities[row["id"]])
    sections: list[Section] = []
    flow = _investor_screen("0780", normalize_query())
    sections.append(_section("investors", "투자자 매매동향", flow["columns"], flow["rows"], status=flow["status"], note=flow["note"]))
    try:
        from app.capture_external import global_sections
        external = global_sections(environment=str(gateway.ENVIRONMENT))
        if isinstance(external, list): sections.extend(section for section in external if isinstance(section, dict))
        else: complete = False; notes.append("Global-market source returned an invalid section list")
    except ImportError:
        notes.append("Global-market source is not installed")
    except Exception:
        notes.append("Global-market source is unavailable")
    return _payload("0200", title, source="kiwoom", status="snapshot" if rows else "missing", note="; ".join(dict.fromkeys(notes)) or "국내 지수는 키움 조회 자료입니다. 해외 지수·환율·원자재는 각 표의 제공처를 확인하세요.", complete=bool(complete and rows), columns=columns, rows=rows, sections=sections)


def _screen_0700(query: dict[str, str | None]) -> CapturePayload:
    title = "종합시황뉴스"
    if not gateway.KIWOOM_ENABLED: return _fixture("0700", title, [], [], "Fixture mode does not contact external news providers.")
    try:
        from app.capture_external import news_snapshot
        payload = news_snapshot(query=str(query["query"]), provider=str(query["provider"]), environment=str(gateway.ENVIRONMENT))
    except ImportError:
        return _missing("0700", title, "The external news module is not installed.")
    except Exception:
        return _payload("0700", title, source="external", status="error", note="The external news source is unavailable.", complete=False, news=[])
    if not isinstance(payload, dict): return _payload("0700", title, source="external", status="error", note="The external news source returned an invalid payload.", complete=False, news=[])
    result = dict(payload)
    result.update({"screen": "0700", "title": result.get("title", title), "environment": result.get("environment", str(gateway.ENVIRONMENT)), "source": result.get("source", "external"), "status": result.get("status", "missing"), "receivedAt": result.get("receivedAt", _now()), "asOf": result.get("asOf"), "note": result.get("note", ""), "complete": bool(result.get("complete", False)), "columns": result.get("columns", []), "rows": result.get("rows", []), "news": result.get("news", [])})
    return result  # type: ignore[return-value]


_SCREEN_QUERY_KEYS = {
    "0198": {"period"},
    "0187": {"market", "venue"},
    "0186": {"market", "venue", "managed"},
    "0184": {"market", "venue", "sort", "session", "stock", "credit", "volumeBand", "priceBand", "valueBand"},
    "0162": {"market", "venue", "direction", "limitSort", "stock", "credit", "volumeBand", "priceBand"},
    "0211": {"venue", "sector", "interval", "end"},
    "0602": {"sector", "interval", "end"},
    "0780": {"market", "venue", "start", "end", "unit", "period"},
    "2797": {"market", "venue", "start", "end", "unit", "period"},
    "0200": set(),
    "0700": {"query", "provider"},
    "0130": set(),
    "0601": set(),
}


def _validate_screen_query(screen: str, query: dict[str, str | None], supplied: set[str]) -> None:
    unsupported = supplied - _SCREEN_QUERY_KEYS[screen]
    if unsupported:
        raise InputError("unsupported screen filter")
    if screen == "0184":
        if str(query["stock"]) not in _RANK_STOCKS or str(query["credit"]) not in _RANK_CREDITS or str(query["volumeBand"]) not in _RANK_VOLUMES or str(query["priceBand"]) not in _RANK_PRICES or str(query["valueBand"]) not in _RANK_VALUES:
            raise InputError("unsupported ranking filter")
    elif screen == "0162":
        if str(query["stock"]) not in _LIMIT_STOCKS or str(query["credit"]) not in _LIMIT_CREDITS or str(query["volumeBand"]) not in _LIMIT_VOLUMES or str(query["priceBand"]) not in _LIMIT_PRICES:
            raise InputError("unsupported limit filter")


def capture_screen(code: str, **raw_query: Any) -> CapturePayload:
    query, screen = normalize_query(**raw_query), str(code or "").strip()
    if screen not in _KNOWN: raise InputError("unknown screen")
    _validate_screen_query(screen, query, set(raw_query))
    try:
        if screen == "0198": payload = _screen_0198(query)
        elif screen in {"0184", "0186"}: payload = _rank(screen, query)
        elif screen == "0162": payload = _screen_0162(query)
        elif screen == "0187": payload = _screen_0187(query)
        elif screen == "0211": payload = _screen_0211(query)
        elif screen == "0602": payload = _screen_0602(query)
        elif screen in {"0780", "2797"}: payload = _investor_screen(screen, query)
        elif screen == "0200": payload = _screen_0200(query)
        elif screen == "0700": payload = _screen_0700(query)
        elif screen == "0130": payload = _missing(screen, "관심종목", "Watchlists remain the existing separate local component; no broker fallback is used.")
        else: payload = _missing(screen, "해외주식 종합차트", "The existing stock-chart component remains separate; no substitute chart feed is used.")
    except gateway.BrokerError:
        payload = _payload(screen, "캡처 화면", source="kiwoom", status="error", note="키움 조회에 실패했습니다. 잠시 후 다시 조회하세요.", complete=False)
    return _with_screen_scope(screen, query, payload)


def _clear_caches_for_tests() -> None:
    global _CAP_SCHEDULER_RUNNING
    with _CAP_LOCK:
        _CAPS.clear()
        _CAP_QUEUE.clear()
        _CAP_SCHEDULER_RUNNING = False
