"""Read-only KR market rankings and investor-flow normalization.

The Kiwoom ranking responses do not carry a reliable KOSPI/KOSDAQ identity.
This module therefore joins each row to the gateway's validated KR symbol index
and omits unresolved rows rather than inventing a listing venue.
"""
from __future__ import annotations

import copy
import math
import re
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from threading import Lock
from app import kiwoom_gateway as gateway


_KR_CODE = re.compile(r"^[0-9A-Z]{6}$")
_MARKETS = {"all": "000", "KOSPI": "001", "KOSDAQ": "101"}
_RANKING_TTL_SECONDS = 30
_INVESTOR_TTL_SECONDS = 60
_CACHE_LOCK = Lock()
_RANKING_CACHE: dict[tuple[str, str, str], tuple[float, dict]] = {}
_INVESTOR_CACHE: dict[tuple[str, str, str, str], tuple[float, dict]] = {}


class IndexLoading(gateway.BrokerError):
    """The KR code/venue index is loading, so identity-safe reads must wait."""

    def __init__(self) -> None:
        super().__init__("symbol index is loading")


_RANKING_CALLS = {
    "gainers": {
        "apiId": "ka10027",
        "path": "/api/dostk/rkinfo",
        "listKey": "pred_pre_flu_rt_upper",
        "body": {
            "sort_tp": "1",
            "trde_qty_cnd": "0000",
            "stk_cnd": "0",
            "crd_cnd": "0",
            "updown_incls": "1",
            "pric_cnd": "0",
            "trde_prica_cnd": "0",
            "stex_tp": "1",
        },
        "metricField": "flu_rt",
        "metricUnit": "percent",
    },
    "volume": {
        "apiId": "ka10030",
        "path": "/api/dostk/rkinfo",
        "listKey": "tdy_trde_qty_upper",
        "body": {
            "sort_tp": "1",
            "mang_stk_incls": "0",
            "crd_tp": "0",
            "trde_qty_tp": "0",
            "pric_tp": "0",
            "trde_prica_tp": "0",
            "mrkt_open_tp": "0",
            "stex_tp": "1",
        },
        "metricField": "trde_qty",
        "metricUnit": "shares",
    },
    "value": {
        "apiId": "ka10032",
        "path": "/api/dostk/rkinfo",
        "listKey": "trde_prica_upper",
        "body": {"mang_stk_incls": "0", "stex_tp": "1"},
        "metricField": "trde_prica",
        "metricUnit": "KRW millions",
    },
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _kst_date() -> str:
    return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")


def _number(value: object, *, absolute: bool = False, price: bool = False) -> float | None:
    """Parse only finite provider numbers, preserving change signs by default."""
    if value is None or str(value).strip() in {"", "-"}:
        return None
    try:
        parsed = float(Decimal(str(value).strip().replace(",", "")))
    except (InvalidOperation, ValueError):
        return None
    if not math.isfinite(parsed):
        return None
    if price and parsed == 0:
        return None
    return abs(parsed) if absolute else parsed


def _cache_get(cache: dict, key: tuple[str, ...], ttl: int) -> dict | None:
    with _CACHE_LOCK:
        cached = cache.get(key)
        if not cached or time.monotonic() - cached[0] >= ttl:
            return None
        return copy.deepcopy(cached[1])


def _cache_put(cache: dict, key: tuple[str, ...], value: dict, *, limit: int = 128) -> dict:
    with _CACHE_LOCK:
        if key not in cache and len(cache) >= limit:
            oldest = min(cache, key=lambda cached_key: cache[cached_key][0])
            cache.pop(oldest, None)
        cache[key] = (time.monotonic(), copy.deepcopy(value))
    return copy.deepcopy(value)


def _ranking_kind(kind: str) -> str:
    value = str(kind or "").lower()
    if value not in _RANKING_CALLS:
        # Deliberately fail before index resolution or broker I/O.
        raise gateway.BrokerError("unsupported ranking kind")
    return value


def _ranking_market(market: str) -> str:
    raw = str(market or "")
    value = raw if raw == "all" else raw.upper()
    if value not in _MARKETS:
        raise gateway.BrokerError("unsupported ranking market")
    return value


def _indexed_kr() -> tuple[dict[str, dict], bool, str]:
    """Return only gateway-validated KRX instruments, keyed by code.

    ``_indexed`` triggers a bounded asynchronous index load when absent.  A
    caller must refresh after that load completes; returning an empty result is
    safer than claiming the provider's rank row belongs to KOSPI by default.
    """
    rows, complete, note = gateway._indexed("KR")
    instruments = {
        str(row.get("stkCd")): row
        for row in rows
        if isinstance(row, dict)
        and row.get("market") == "KR"
        and row.get("stexTp") == "KRX"
        and row.get("quoteVenue") == "KRX"
        and row.get("listingVenue") in {"KOSPI", "KOSDAQ"}
        and _KR_CODE.fullmatch(str(row.get("stkCd") or ""))
    }
    return instruments, bool(complete), str(note or "")


def _instrument_for(code: object, indexed: dict[str, dict], market: str) -> dict | None:
    instrument = indexed.get(str(code or "").strip().upper())
    if instrument is None:
        return None
    if market != "all" and instrument["listingVenue"] != market:
        return None
    return {
        key: instrument[key]
        for key in (
            "market",
            "stkCd",
            "stkNm",
            "stexTp",
            "listingVenue",
            "quoteVenue",
            "currency",
            "environment",
        )
    }


def _ranking_item(row: dict, *, rank: int, kind: str, instrument: dict) -> dict:
    call = _RANKING_CALLS[kind]
    price = _number(row.get("cur_prc"), absolute=True, price=True)
    volume_field = "trde_qty" if kind == "volume" else "now_trde_qty"
    return {
        "rank": int(_number(row.get("now_rank"), absolute=True) or rank),
        "instrument": instrument,
        "price": price,
        "change": _number(row.get("pred_pre")),
        "changePct": _number(row.get("flu_rt")),
        "volume": _number(row.get(volume_field), absolute=True),
        "volumeUnit": "shares",
        "tradingValue": _number(row.get("trde_prica") or row.get("trde_amt"), absolute=True),
        "tradingValueUnit": "KRW millions",
        "metric": _number(row.get(call["metricField"]), absolute=kind != "gainers"),
        "metricUnit": call["metricUnit"],
    }


def _fixture_instrument(code: str, listing_venue: str, name: str) -> dict:
    return {
        "market": "KR",
        "stkCd": code,
        "stkNm": name,
        "stexTp": "KRX",
        "listingVenue": listing_venue,
        "quoteVenue": "KRX",
        "currency": "KRW",
        "environment": "fixture",
    }


_FIXTURE_RANKS = (
    ("005930", "KOSPI", "삼성전자", 71500.0, 500.0, 0.70, 11_200_000.0, 800_800.0),
    ("000660", "KOSPI", "SK하이닉스", 185000.0, 3000.0, 1.64, 2_300_000.0, 425_500.0),
    ("247540", "KOSDAQ", "에코프로비엠", 128000.0, -1000.0, -0.78, 410_000.0, 52_480.0),
)


def _fixture_rankings(kind: str, market: str) -> dict:
    rows = [row for row in _FIXTURE_RANKS if market == "all" or row[1] == market]
    if kind == "gainers":
        rows.sort(key=lambda row: row[5], reverse=True)
    elif kind == "volume":
        rows.sort(key=lambda row: row[6], reverse=True)
    else:
        rows.sort(key=lambda row: row[7], reverse=True)
    metric_index = {"gainers": 5, "volume": 6, "value": 7}[kind]
    metric_unit = _RANKING_CALLS[kind]["metricUnit"]
    items = [
        {
            "rank": rank,
            "instrument": _fixture_instrument(code, venue, name),
            "price": price,
            "change": change,
            "changePct": change_pct,
            "volume": volume,
            "volumeUnit": "shares",
            "tradingValue": value,
            "tradingValueUnit": "KRW millions",
            "metric": row[metric_index],
            "metricUnit": metric_unit,
        }
        for rank, row in enumerate(rows, start=1)
        for code, venue, name, price, change, change_pct, volume, value in [row]
    ]
    return {
        "kind": kind,
        "market": market,
        "items": items,
        "source": "fixture",
        "asOf": "2026-10-24T00:00:00Z",
        "complete": True,
        "incomplete": False,
        "note": "Deterministic fixture/test data; not broker ranking data.",
    }


def get_rankings(*, kind: str, market: str) -> dict:
    """Return normalized KR gainers, volume, or value rankings.

    Every live request goes through ``gateway._fetch_rows``.  The gateway must
    explicitly allow the official API id/path pair before this function can
    create any Kiwoom client or network request.
    """
    selected_kind = _ranking_kind(kind)
    selected_market = _ranking_market(market)
    environment = str(gateway.ENVIRONMENT)
    cache_key = (environment, selected_kind, selected_market)
    if cached := _cache_get(_RANKING_CACHE, cache_key, _RANKING_TTL_SECONDS):
        return cached
    if not gateway.KIWOOM_ENABLED:
        return _cache_put(_RANKING_CACHE, cache_key, _fixture_rankings(selected_kind, selected_market))

    indexed, index_complete, index_note = _indexed_kr()
    if not indexed and not index_complete:
        # The gateway has started its bounded index load.  Do not spend a
        # ranking request or cache this ambiguous zero-row transitional state.
        return {
            "kind": selected_kind,
            "market": selected_market,
            "items": [],
            "source": "kiwoom",
            "asOf": _utc_now(),
            "complete": False,
            "incomplete": True,
            "note": index_note or "KR symbol index is loading in the background",
        }

    call = _RANKING_CALLS[selected_kind]
    body = {"mrkt_tp": _MARKETS[selected_market], **call["body"]}
    rows, provider_complete, provider_note = gateway._fetch_rows(
        call["apiId"], call["path"], body, call["listKey"], max_pages=5
    )
    items, omitted = [], 0
    for position, row in enumerate(rows, start=1):
        instrument = _instrument_for(row.get("stk_cd"), indexed, selected_market)
        if instrument is None:
            omitted += 1
            continue
        items.append(_ranking_item(row, rank=position, kind=selected_kind, instrument=instrument))
    notes = [text for text in (provider_note, index_note) if text]
    if omitted:
        notes.append(f"{omitted} rows omitted until a validated KR listing identity is available")
    complete = bool(provider_complete and index_complete and not omitted)
    result = {
        "kind": selected_kind,
        "market": selected_market,
        "items": items,
        "source": "kiwoom",
        "asOf": _utc_now(),
        "complete": complete,
        "incomplete": not complete,
        "note": "; ".join(notes),
    }
    return _cache_put(_RANKING_CACHE, cache_key, result)


def _validated_kr_instrument(stk_cd: str, listing_venue: str) -> dict:
    code, venue = str(stk_cd or "").strip().upper(), str(listing_venue or "").strip().upper()
    if not _KR_CODE.fullmatch(code):
        raise gateway.BrokerError("invalid KR stock code")
    if venue not in {"KOSPI", "KOSDAQ"}:
        raise gateway.BrokerError("invalid KR listing venue")
    if not gateway.KIWOOM_ENABLED:
        for fixture in _FIXTURE_RANKS:
            if fixture[0] == code and fixture[1] == venue:
                return _fixture_instrument(fixture[0], fixture[1], fixture[2])
        raise gateway.BrokerError("KR instrument is not available in fixture data")
    indexed, complete, note = _indexed_kr()
    if not indexed and not complete and "loading" in note.lower():
        raise IndexLoading()
    instrument = _instrument_for(code, indexed, venue)
    if instrument is None:
        # Do not query ka10059 with a client-supplied listing identity.  The
        # index must first attest the code/venue pair.
        raise gateway.BrokerError("KR instrument identity requires symbol lookup")
    return instrument


_INVESTOR_FIELDS = {
    "individual": "ind_invsr",
    "foreign": "frgnr_invsr",
    "institutional": "orgn",
    "financialInvestment": "fnnc_invt",
    "insurance": "insrnc",
    "investmentTrust": "invtrt",
    "otherFinancial": "etc_fnnc",
    "bank": "bank",
    "pensionEtc": "penfnd_etc",
    "privateFund": "samo_fund",
    "nation": "natn",
    "otherCorporation": "etc_corp",
    "domesticForeign": "natfor",
}


def _investor_row(row: dict) -> dict | None:
    date = str(row.get("dt") or "").strip()
    try:
        datetime.strptime(date, "%Y%m%d")
    except ValueError:
        return None
    return {"date": date, **{name: _number(row.get(field)) for name, field in _INVESTOR_FIELDS.items()}}


def _fixture_investor_flow(instrument: dict) -> dict:
    return {
        "instrument": instrument,
        "date": "20261024",
        "valueKind": "net_buy_quantity",
        "unit": "shares",
        "rows": [
            {
                "date": "20261024",
                "individual": -1200.0,
                "foreign": 700.0,
                "institutional": 500.0,
                "financialInvestment": 210.0,
                "insurance": 40.0,
                "investmentTrust": 100.0,
                "otherFinancial": 0.0,
                "bank": 0.0,
                "pensionEtc": 90.0,
                "privateFund": 60.0,
                "nation": 0.0,
                "otherCorporation": 0.0,
                "domesticForeign": 0.0,
            }
        ],
        "source": "fixture",
        "asOf": "2026-10-24T00:00:00Z",
        "complete": True,
        "incomplete": False,
        "note": "Deterministic fixture/test data; date-based net-buy quantity, not real-time investor flow.",
    }


def get_investor_flow(*, stk_cd: str, listing_venue: str) -> dict:
    """Return date-based KR investor net-buy quantity rows in whole shares."""
    instrument = _validated_kr_instrument(stk_cd, listing_venue)
    date = _kst_date()
    cache_key = (str(gateway.ENVIRONMENT), instrument["stkCd"], instrument["listingVenue"], date)
    if cached := _cache_get(_INVESTOR_CACHE, cache_key, _INVESTOR_TTL_SECONDS):
        return cached
    if not gateway.KIWOOM_ENABLED:
        return _cache_put(_INVESTOR_CACHE, cache_key, _fixture_investor_flow(instrument))
    rows, provider_complete, provider_note = gateway._fetch_rows(
        "ka10059",
        "/api/dostk/stkinfo",
        {"dt": date, "stk_cd": instrument["stkCd"], "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1"},
        "stk_invsr_orgn",
        max_pages=5,
    )
    normalized = [item for row in rows if (item := _investor_row(row))]
    omitted = len(rows) - len(normalized)
    notes = [text for text in (provider_note,) if text]
    if omitted:
        notes.append(f"{omitted} investor rows omitted because their date was invalid")
    complete = bool(provider_complete and not omitted)
    result = {
        "instrument": instrument,
        "date": date,
        "valueKind": "net_buy_quantity",
        "unit": "shares",
        "rows": normalized,
        "source": "kiwoom",
        "asOf": _utc_now(),
        "complete": complete,
        "incomplete": not complete,
        "note": "; ".join(notes) or "Date-based net-buy quantity; not real-time investor flow.",
    }
    return _cache_put(_INVESTOR_CACHE, cache_key, result)


def _clear_caches_for_tests() -> None:
    """Keep unit tests deterministic without exposing cache mutation to routes."""
    with _CACHE_LOCK:
        _RANKING_CACHE.clear()
        _INVESTOR_CACHE.clear()
