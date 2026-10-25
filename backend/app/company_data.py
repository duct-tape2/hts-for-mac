"""Bounded public-company data adapters for SEC EDGAR and optional OpenDART.

This module is intentionally route-free and independent from broker/auth code.
It only requests a small fixed set of official JSON endpoints, accepts no URL
from a caller, and never reads or persists a DART key.  Callers supply the
SEC contact User-Agent and, when using DART, an explicit per-call key.
"""
from __future__ import annotations

import copy
import json
import math
import re
import time
from datetime import date, datetime, timezone
from threading import BoundedSemaphore, Lock
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


_SEC_DATA_HOST = "data.sec.gov"
_SEC_WEB_HOST = "www.sec.gov"
_DART_API_HOST = "opendart.fss.or.kr"
_DART_VIEWER_HOST = "dart.fss.or.kr"
_SEC_SOURCE = "sec"
_DART_SOURCE = "dart"
_TIMEOUT_SECONDS = 8.0
_TICKER_MAX_BYTES = 2 * 1024 * 1024
_SUBMISSIONS_MAX_BYTES = 5 * 1024 * 1024
_FACTS_MAX_BYTES = 12 * 1024 * 1024
_DART_MAX_BYTES = 3 * 1024 * 1024
_DART_FINANCIAL_MAX_BYTES = 8 * 1024 * 1024
_SEC_FACT_ROW_LIMIT = 120
_DART_FINANCIAL_ROW_LIMIT = 1000
_CACHE_LIMIT = 64
_SEC_TICKER_TTL = 6 * 60 * 60
_COMPANY_TTL = 5 * 60
_MIN_REQUEST_GAP_SECONDS = 0.12
_HTTP_SLOTS = BoundedSemaphore(2)
_PACE_LOCK = Lock()
_NEXT_REQUEST_AT = 0.0
_CACHE_LOCK = Lock()
_CACHE: dict[tuple[object, ...], tuple[float, object]] = {}

_SYMBOL = re.compile(r"^[A-Z][A-Z0-9.-]{0,14}$")
_CIK = re.compile(r"^\d{1,10}$")
_CORP_CODE = re.compile(r"^\d{8}$")
_DART_KEY = re.compile(r"^[A-Za-z0-9]{40}$")
_YEAR = re.compile(r"^(20\d{2})$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ACCESSION = re.compile(r"^\d{10}-\d{2}-\d{6}$")
_DOCUMENT = re.compile(r"^[A-Za-z0-9_.-]{1,180}$")
_RECEIPT = re.compile(r"^\d{14}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_DART_REPORT_CODES = {
    "11011": "annual report",
    "11012": "semi-annual report",
    "11013": "first-quarter report",
    "11014": "third-quarter report",
}
_DART_FS_DIVS = {"CFS": "consolidated", "OFS": "separate"}

def _parameter(key: str, label: str, kind: str, default: str, options: tuple[tuple[str, str], ...] | None = None) -> dict[str, object]:
    result: dict[str, object] = {"key": key, "label": label, "type": kind, "default": default}
    if options is not None:
        result["options"] = [{"value": value, "label": option_label} for value, option_label in options]
    return result


# Public metadata only: callers cannot use it as an arbitrary provider proxy.
# DART credentials intentionally are not a query parameter. A future
# credential flow may inject one into get_feature in memory, never via a URL.
FEATURES: dict[str, dict[str, object]] = {
    "sec_filings": {
        "featureId": "sec_filings",
        "title": "SEC 최근 공시",
        "market": "US",
        "source": _SEC_SOURCE,
        "description": "SEC EDGAR의 최근 제출 공시입니다. 연락처 이메일을 포함한 정직한 User-Agent가 필요합니다.",
        "parameters": [
            _parameter("symbol", "미국 티커", "text", ""),
            _parameter("cik", "SEC CIK", "text", ""),
            _parameter("limit", "최대 공시 수", "number", "20"),
        ],
    },
    "sec_financials": {
        "featureId": "sec_financials",
        "title": "SEC 보고 재무 수치",
        "market": "US",
        "source": _SEC_SOURCE,
        "description": "SEC XBRL 회사 사실에서 보고된 연간·분기 수치만 표시합니다. 추정치나 컨센서스는 포함하지 않습니다.",
        "parameters": [
            _parameter("symbol", "미국 티커", "text", ""),
            _parameter("cik", "SEC CIK", "text", ""),
        ],
    },
    "dart_disclosures": {
        "featureId": "dart_disclosures",
        "title": "OpenDART 공시",
        "market": "KR",
        "source": _DART_SOURCE,
        "description": "OpenDART 공식 법인 공시입니다. API 키는 URL이 아닌 별도 안전한 주입 경로에서만 전달합니다.",
        "parameters": [
            _parameter("corpCode", "OpenDART 법인코드", "text", ""),
            _parameter("reportPeriod", "공시 기간 연도", "text", ""),
        ],
    },
    "dart_financials": {
        "featureId": "dart_financials",
        "title": "OpenDART 전체 재무제표",
        "market": "KR",
        "source": _DART_SOURCE,
        "description": "OpenDART XBRL 전체 재무제표의 보고 계정·통화·기간을 원문 값 그대로 표시합니다.",
        "parameters": [
            _parameter("corpCode", "OpenDART 법인코드", "text", ""),
            _parameter("reportYear", "사업연도", "text", ""),
            _parameter("reportCode", "보고서 코드", "select", "11011", (
                ("11013", "1분기보고서"), ("11012", "반기보고서"),
                ("11014", "3분기보고서"), ("11011", "사업보고서"),
            )),
            _parameter("fsDiv", "연결/개별", "select", "CFS", (("CFS", "연결재무제표"), ("OFS", "개별재무제표"))),
        ],
    },
}

# Alias kept for integrations that use the descriptive registry name.
FEATURE_REGISTRY = FEATURES

_METRICS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("revenue", "Revenue", ("RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "Revenues")),
    ("netIncome", "Net income", ("NetIncomeLoss",)),
    ("assets", "Assets", ("Assets",)),
    ("liabilities", "Liabilities", ("Liabilities",)),
    ("cash", "Cash and cash equivalents", ("CashAndCashEquivalentsAtCarryingValue",)),
)


class CompanyDataUnavailable(RuntimeError):
    pass


class CompanyDataAccessDenied(CompanyDataUnavailable):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _cache_get(key: tuple[object, ...]) -> object | None:
    with _CACHE_LOCK:
        entry = _CACHE.get(key)
        if entry is None or entry[0] <= time.monotonic():
            _CACHE.pop(key, None)
            return None
        return copy.deepcopy(entry[1])


def _cache_put(key: tuple[object, ...], value: object, ttl: float) -> object:
    with _CACHE_LOCK:
        if key not in _CACHE and len(_CACHE) >= _CACHE_LIMIT:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = (time.monotonic() + ttl, copy.deepcopy(value))
    return copy.deepcopy(value)


def _fixed_url(url: str) -> None:
    """Permit only module-generated paths on the four documented hosts."""
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ValueError("company-data URL is not allowlisted") from exc
    if parsed.scheme != "https" or parsed.username is not None or parsed.password is not None or port not in {None, 443}:
        raise ValueError("company-data URL is not allowlisted")
    path = parsed.path
    dart_query: dict[str, str] = {}
    try:
        items = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
        if len(items) == len({key for key, _ in items}):
            dart_query = dict(items)
    except ValueError:
        pass
    dart_allowed = (
        parsed.hostname == _DART_API_HOST
        and path == "/api/list.json"
        and set(dart_query) == {"crtfc_key", "corp_code", "bgn_de", "end_de", "page_no", "page_count", "sort", "sort_mth"}
        and _DART_KEY.fullmatch(dart_query.get("crtfc_key", "")) is not None
        and _CORP_CODE.fullmatch(dart_query.get("corp_code", "")) is not None
        and re.fullmatch(r"20\d{6}", dart_query.get("bgn_de", "")) is not None
        and re.fullmatch(r"20\d{6}", dart_query.get("end_de", "")) is not None
        and dart_query.get("page_no") == "1"
        and dart_query.get("page_count") == "100"
        and dart_query.get("sort") == "date"
        and dart_query.get("sort_mth") == "desc"
    )
    dart_financial_allowed = (
        parsed.hostname == _DART_API_HOST
        and path == "/api/fnlttSinglAcntAll.json"
        and set(dart_query) == {"crtfc_key", "corp_code", "bsns_year", "reprt_code", "fs_div"}
        and _DART_KEY.fullmatch(dart_query.get("crtfc_key", "")) is not None
        and _CORP_CODE.fullmatch(dart_query.get("corp_code", "")) is not None
        and _YEAR.fullmatch(dart_query.get("bsns_year", "")) is not None
        and dart_query.get("reprt_code") in _DART_REPORT_CODES
        and dart_query.get("fs_div") in _DART_FS_DIVS
    )
    allowed = (
        (parsed.hostname == _SEC_WEB_HOST and path == "/files/company_tickers.json" and not parsed.query)
        or (parsed.hostname == _SEC_DATA_HOST and re.fullmatch(r"/submissions/CIK\d{10}\.json", path) is not None and not parsed.query)
        or (parsed.hostname == _SEC_DATA_HOST and re.fullmatch(r"/api/xbrl/companyfacts/CIK\d{10}\.json", path) is not None and not parsed.query)
        or dart_allowed
        or dart_financial_allowed
    )
    if not allowed:
        raise ValueError("company-data URL is not allowlisted")


def _pace() -> None:
    global _NEXT_REQUEST_AT
    with _PACE_LOCK:
        delay = _NEXT_REQUEST_AT - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        _NEXT_REQUEST_AT = time.monotonic() + _MIN_REQUEST_GAP_SECONDS


def _urllib_transport(url: str, *, headers: dict[str, str], timeout: float, max_bytes: int) -> bytes:
    _fixed_url(url)
    request = Request(url, headers=headers)
    try:
        with build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
            if response.getcode() != 200:
                raise CompanyDataUnavailable("official provider returned an unexpected status")
            length = response.headers.get("Content-Length")
            if length is not None and int(length) > max_bytes:
                raise CompanyDataUnavailable("official response exceeds size cap")
            body = response.read(max_bytes + 1)
    except HTTPError as exc:
        if exc.code == 403:
            raise CompanyDataAccessDenied("official provider denied access") from exc
        raise CompanyDataUnavailable("official provider unavailable") from exc
    except (URLError, OSError, ValueError) as exc:
        raise CompanyDataUnavailable("official provider unavailable") from exc
    if len(body) > max_bytes:
        raise CompanyDataUnavailable("official response exceeds size cap")
    return body


# Tests replace this function. It only receives module-created fixed URLs.
_transport = _urllib_transport


def _fetch_json(url: str, *, headers: dict[str, str], max_bytes: int) -> dict[str, object]:
    _fixed_url(url)
    if not _HTTP_SLOTS.acquire(timeout=_TIMEOUT_SECONDS):
        raise CompanyDataUnavailable("public-data request capacity is busy")
    try:
        _pace()
        body = _transport(url, headers=headers, timeout=_TIMEOUT_SECONDS, max_bytes=max_bytes)
    finally:
        _HTTP_SLOTS.release()
    if not isinstance(body, bytes) or len(body) > max_bytes:
        raise CompanyDataUnavailable("official response exceeds size cap")
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CompanyDataUnavailable("official provider returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise CompanyDataUnavailable("official provider returned invalid JSON")
    return value


def _safe_text(value: object, maximum: int = 240) -> str:
    text = " ".join(str(value or "").split())
    return _CONTROL.sub("", text)[:maximum]


def _finite(value: object) -> float | int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return value


def _columns(*columns: tuple[str, str, bool, str | None]) -> list[dict[str, object]]:
    return [{"key": key, "label": label, "numeric": numeric, **({"unit": unit} if unit else {})} for key, label, numeric, unit in columns]


def _payload(feature_id: str, *, title: str, market: str, source: str, status: str, note: str, complete: bool, columns: list[dict[str, object]], rows: list[dict[str, object]], parameters: dict[str, object], scope: dict[str, object], as_of: str | None = None) -> dict[str, object]:
    return {
        "featureId": feature_id,
        "title": title,
        "market": market,
        "source": source,
        "status": status,
        "receivedAt": _utc_now() if status in {"snapshot", "partial"} else None,
        "asOf": as_of,
        "note": note,
        "complete": complete,
        "columns": columns,
        "rows": rows,
        "parameters": parameters,
        "scope": scope,
    }


def _setup(feature_id: str, *, title: str, market: str, source: str, note: str, columns: list[dict[str, object]], parameters: dict[str, object]) -> dict[str, object]:
    return _payload(feature_id, title=title, market=market, source=source, status="setup-required", note=note, complete=False, columns=columns, rows=[], parameters=parameters, scope={"provider": source})


def _failure(feature_id: str, *, title: str, market: str, source: str, error: Exception, columns: list[dict[str, object]], parameters: dict[str, object]) -> dict[str, object]:
    if isinstance(error, CompanyDataAccessDenied):
        note = "Official provider denied this request. Do not bypass it; verify the declared contact and provider access policy."
    else:
        note = "Official provider is unavailable or returned an invalid bounded response."
    return _payload(feature_id, title=title, market=market, source=source, status="error", note=note, complete=False, columns=columns, rows=[], parameters=parameters, scope={"provider": source})


def _symbol(value: str) -> str:
    normalized = str(value or "").upper().strip()
    if not _SYMBOL.fullmatch(normalized):
        raise ValueError("symbol must be a US ticker")
    return normalized


def _cik(value: str | int) -> str:
    raw = str(value).strip()
    if not _CIK.fullmatch(raw):
        raise ValueError("CIK must contain one to ten digits")
    return raw.zfill(10)


def _sec_user_agent(value: str | None) -> str | None:
    if value is None or not str(value).strip():
        return None
    text = str(value).strip()
    email = re.search(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b", text)
    label = text[:email.start()].strip(" ()<>-–—") if email else ""
    try:
        text.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError("SEC User-Agent must use an English (ASCII) application name and contact email") from exc
    if len(text) > 180 or _CONTROL.search(text) or email is None or not label:
        raise ValueError("SEC User-Agent must use an English (ASCII) application name and contact email")
    return text


def _sec_headers(user_agent: str) -> dict[str, str]:
    return {"Accept": "application/json", "User-Agent": user_agent}


def _ticker_index(user_agent: str) -> dict[str, dict[str, object]]:
    key = ("sec", "tickers")
    cached = _cache_get(key)
    if isinstance(cached, dict):
        return cached  # type: ignore[return-value]
    raw = _fetch_json("https://www.sec.gov/files/company_tickers.json", headers=_sec_headers(user_agent), max_bytes=_TICKER_MAX_BYTES)
    result: dict[str, dict[str, object]] = {}
    for value in raw.values():
        if not isinstance(value, dict):
            continue
        ticker = str(value.get("ticker") or "").upper()
        cik = str(value.get("cik_str") or "")
        if _SYMBOL.fullmatch(ticker) and _CIK.fullmatch(cik):
            result[ticker] = {"cik": cik.zfill(10), "name": _safe_text(value.get("title"), 180)}
    if not result:
        raise CompanyDataUnavailable("SEC ticker mapping was invalid")
    return _cache_put(key, result, _SEC_TICKER_TTL)  # type: ignore[return-value]


def _resolve_cik(*, symbol: str | None, cik: str | int | None, user_agent: str) -> tuple[str, str | None]:
    if cik is not None and str(cik).strip():
        return _cik(cik), _symbol(symbol) if symbol else None
    ticker = _symbol(symbol or "")
    found = _ticker_index(user_agent).get(ticker)
    if found is None:
        raise LookupError("ticker was not found in SEC company_tickers.json")
    return str(found["cik"]), ticker


def _sec_fetch(kind: str, cik: str, user_agent: str) -> dict[str, object]:
    if kind == "submissions":
        url, cap, ttl = f"https://data.sec.gov/submissions/CIK{cik}.json", _SUBMISSIONS_MAX_BYTES, _COMPANY_TTL
    elif kind == "facts":
        url, cap, ttl = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json", _FACTS_MAX_BYTES, _COMPANY_TTL
    else:
        raise ValueError("unsupported SEC resource")
    key = ("sec", kind, cik)
    cached = _cache_get(key)
    if isinstance(cached, dict):
        return cached  # type: ignore[return-value]
    return _cache_put(key, _fetch_json(url, headers=_sec_headers(user_agent), max_bytes=cap), ttl)  # type: ignore[return-value]


def _filing_url(cik: str, accession: str, document: object) -> str:
    name = str(document or "")
    if not _ACCESSION.fullmatch(accession) or not _DOCUMENT.fullmatch(name):
        return ""
    return f"https://{_SEC_WEB_HOST}/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/{name}"


_FILING_COLUMNS = _columns(
    ("filed", "Filed", False, None), ("reportDate", "Report date", False, None),
    ("form", "Form", False, None), ("accession", "Accession", False, None),
    ("officialURL", "Official filing", False, None),
)


def _sec_filings(*, symbol: str | None, cik: str | int | None, limit: int, sec_user_agent: str | None) -> dict[str, object]:
    parameters = {"symbol": symbol or "", "cik": str(cik or ""), "limit": limit, "secUserAgentRequired": True}
    user_agent = _sec_user_agent(sec_user_agent)
    if user_agent is None:
        return _setup("sec_filings", title="SEC 최근 공시", market="US", source=_SEC_SOURCE, note="SEC requires a truthful automated-tool User-Agent with a contact email. Supply it explicitly; this app will not invent one.", columns=_FILING_COLUMNS, parameters=parameters)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise ValueError("limit must be an integer from 1 through 100")
    try:
        resolved_cik, resolved_symbol = _resolve_cik(symbol=symbol, cik=cik, user_agent=user_agent)
        payload = _sec_fetch("submissions", resolved_cik, user_agent)
    except LookupError:
        return _payload("sec_filings", title="SEC 최근 공시", market="US", source=_SEC_SOURCE, status="missing", note="The supplied ticker is absent from the official SEC ticker mapping.", complete=True, columns=_FILING_COLUMNS, rows=[], parameters=parameters, scope={"provider": "SEC EDGAR", "symbol": symbol or ""})
    except CompanyDataUnavailable as error:
        return _failure("sec_filings", title="SEC 최근 공시", market="US", source=_SEC_SOURCE, error=error, columns=_FILING_COLUMNS, parameters=parameters)
    recent = payload.get("filings")
    recent = recent.get("recent") if isinstance(recent, dict) else None
    if not isinstance(recent, dict):
        return _failure("sec_filings", title="SEC 최근 공시", market="US", source=_SEC_SOURCE, error=CompanyDataUnavailable(), columns=_FILING_COLUMNS, parameters=parameters)
    forms, filed, reports, accessions, documents = (recent.get(key) for key in ("form", "filingDate", "reportDate", "accessionNumber", "primaryDocument"))
    arrays = (forms, filed, reports, accessions, documents)
    if not all(isinstance(value, list) for value in arrays):
        return _failure("sec_filings", title="SEC 최근 공시", market="US", source=_SEC_SOURCE, error=CompanyDataUnavailable(), columns=_FILING_COLUMNS, parameters=parameters)
    rows: list[dict[str, object]] = []
    for index in range(min(len(forms), len(filed), len(reports), len(accessions), len(documents), limit)):
        accession = str(accessions[index] or "")
        filed_date = str(filed[index] or "")
        form = _safe_text(forms[index], 40)
        if not _ACCESSION.fullmatch(accession) or not _DATE.fullmatch(filed_date) or not form:
            continue
        rows.append({"id": accession, "filed": filed_date, "reportDate": str(reports[index] or "") if _DATE.fullmatch(str(reports[index] or "")) else "", "form": form, "accession": accession, "officialURL": _filing_url(resolved_cik, accession, documents[index])})
    return _payload("sec_filings", title="SEC 최근 공시", market="US", source=_SEC_SOURCE, status="snapshot" if rows else "missing", note="Recent SEC filing records; official links point to EDGAR Archives when a primary document is available.", complete=True, columns=_FILING_COLUMNS, rows=rows, parameters=parameters, scope={"provider": "SEC EDGAR", "cik": resolved_cik, "symbol": resolved_symbol or "", "returnedRows": len(rows)}, as_of=rows[0]["filed"] if rows else None)


_FINANCIAL_COLUMNS = _columns(
    ("metric", "Metric", False, None), ("periodType", "Period", False, None), ("fiscalYear", "Fiscal year", True, None),
    ("fiscalPeriod", "Fiscal period", False, None), ("reportStart", "Period start", False, None), ("reportEnd", "Period end", False, None),
    ("periodKind", "Fact kind", False, None), ("periodDays", "Reported days", True, "days"),
    ("filed", "Filed", False, None), ("form", "Form", False, None), ("amendment", "Amendment", False, None),
    ("unit", "Unit", False, None), ("value", "Reported value", True, None),
)


def _period_shape(fp: str, start: str, end: str, frame: str) -> tuple[str, str, int | None]:
    """Describe provider-reported periods without deriving a new value.

    SEC duration facts sometimes provide both a fiscal YTD and standalone Q2
    duration.  They are retained as distinct observations.  The conservative
    labels below use a duration only when it clearly identifies the shape;
    anything between those ranges remains a generic reported duration.
    """
    if not start:
        return "instant", "instant", None
    days = (date.fromisoformat(end) - date.fromisoformat(start)).days
    if fp == "FY":
        return "annual", "duration", days
    # SEC's optional frame is direct provenance when present.  It is more
    # precise than a calendar-duration fallback for non-calendar fiscal years.
    if frame.endswith("YTD"):
        return "yearToDate", "duration", days
    if re.search(r"Q[1-3]$", frame):
        return "quarterly", "duration", days
    if fp == "Q1" or days <= 115:
        return "quarterly", "duration", days
    if fp in {"Q2", "Q3"} and days >= 135:
        return "yearToDate", "duration", days
    return "duration", "duration", days


def _fact_rows(facts: dict[str, object]) -> tuple[list[dict[str, object]], int]:
    us_gaap = facts.get("facts")
    us_gaap = us_gaap.get("us-gaap") if isinstance(us_gaap, dict) else None
    if not isinstance(us_gaap, dict):
        raise CompanyDataUnavailable("companyfacts response lacks us-gaap facts")
    selected: dict[tuple[object, ...], dict[str, object]] = {}
    allowed_forms = {"10-K", "10-Q", "20-F", "40-F"}
    for metric_id, label, tags in _METRICS:
        concept = next((us_gaap.get(tag) for tag in tags if isinstance(us_gaap.get(tag), dict)), None)
        if not isinstance(concept, dict):
            continue
        units = concept.get("units")
        if not isinstance(units, dict):
            continue
        for unit, entries in units.items():
            if not isinstance(unit, str) or not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                form = str(entry.get("form") or "")
                base_form = form.removesuffix("/A")
                fp, fy, filed = str(entry.get("fp") or ""), entry.get("fy"), str(entry.get("filed") or "")
                value = _finite(entry.get("val"))
                if base_form not in allowed_forms or fp not in {"FY", "Q1", "Q2", "Q3"} or not isinstance(fy, int) or not _DATE.fullmatch(filed) or value is None:
                    continue
                if fp == "FY" and base_form not in {"10-K", "20-F", "40-F"}:
                    continue
                if fp != "FY" and base_form != "10-Q":
                    continue
                start, end = str(entry.get("start") or ""), str(entry.get("end") or "")
                if start and not _DATE.fullmatch(start):
                    continue
                if end and not _DATE.fullmatch(end):
                    continue
                frame = str(entry.get("frame") or "")
                period_type, period_kind, period_days = _period_shape(fp, start, end, frame) if end else ("instant", "instant", None)
                key = (metric_id, fy, fp, unit, start, end)
                row = {"id": f"{metric_id}:{fy}:{fp}:{unit}:{start or 'instant'}:{end or filed}", "metric": label, "periodType": period_type, "fiscalYear": fy, "fiscalPeriod": fp, "reportStart": start, "reportEnd": end, "periodKind": period_kind, "periodDays": period_days, "filed": filed, "form": form, "amendment": form.endswith("/A"), "unit": unit, "value": value}
                previous = selected.get(key)
                if previous is None or (str(row["filed"]), bool(row["amendment"])) >= (str(previous["filed"]), bool(previous["amendment"])):
                    selected[key] = row
    all_rows = list(selected.values())
    if len(all_rows) <= _SEC_FACT_ROW_LIMIT:
        return _ordered_fact_rows(all_rows), len(all_rows)

    # A metric-first slice can omit Revenue or Net income entirely.  Take the
    # most recent retained fact from each metric in rounds, then apply the
    # stable display ordering after the bounded selection.
    grouped: dict[str, list[dict[str, object]]] = {}
    for row in all_rows:
        grouped.setdefault(str(row["metric"]), []).append(row)
    metric_order = [label for _metric_id, label, _tags in _METRICS if label in grouped]
    for label in metric_order:
        grouped[label].sort(key=_latest_fact_key, reverse=True)
    offsets = {label: 0 for label in metric_order}
    display: list[dict[str, object]] = []
    while len(display) < _SEC_FACT_ROW_LIMIT:
        made_progress = False
        for label in metric_order:
            offset = offsets[label]
            choices = grouped[label]
            if offset >= len(choices):
                continue
            display.append(choices[offset])
            offsets[label] += 1
            made_progress = True
            if len(display) == _SEC_FACT_ROW_LIMIT:
                break
        if not made_progress:
            break
    return _ordered_fact_rows(display), len(all_rows)


def _latest_fact_key(row: dict[str, object]) -> tuple[int, int, int, bool]:
    period_order = {"FY": 4, "Q3": 3, "Q2": 2, "Q1": 1}
    return (
        int(row["fiscalYear"]), period_order[str(row["fiscalPeriod"])],
        int(str(row["filed"]).replace("-", "")), bool(row["amendment"]),
    )


def _ordered_fact_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    metric_order = {label: index for index, (_metric_id, label, _tags) in enumerate(_METRICS)}
    return sorted(rows, key=lambda row: (metric_order[str(row["metric"])], *(-value for value in _latest_fact_key(row)[:3]), not bool(row["amendment"])))


def _sec_financials(*, symbol: str | None, cik: str | int | None, sec_user_agent: str | None) -> dict[str, object]:
    parameters = {"symbol": symbol or "", "cik": str(cik or ""), "secUserAgentRequired": True, "reportedOnly": True}
    user_agent = _sec_user_agent(sec_user_agent)
    if user_agent is None:
        return _setup("sec_financials", title="SEC 보고 재무 수치", market="US", source=_SEC_SOURCE, note="SEC requires a truthful automated-tool User-Agent with a contact email. Supply it explicitly; this app will not invent one.", columns=_FINANCIAL_COLUMNS, parameters=parameters)
    try:
        resolved_cik, resolved_symbol = _resolve_cik(symbol=symbol, cik=cik, user_agent=user_agent)
        facts = _sec_fetch("facts", resolved_cik, user_agent)
        rows, available_rows = _fact_rows(facts)
    except LookupError:
        return _payload("sec_financials", title="SEC 보고 재무 수치", market="US", source=_SEC_SOURCE, status="missing", note="The supplied ticker is absent from the official SEC ticker mapping.", complete=True, columns=_FINANCIAL_COLUMNS, rows=[], parameters=parameters, scope={"provider": "SEC EDGAR", "symbol": symbol or ""})
    except CompanyDataUnavailable as error:
        return _failure("sec_financials", title="SEC 보고 재무 수치", market="US", source=_SEC_SOURCE, error=error, columns=_FINANCIAL_COLUMNS, parameters=parameters)
    truncated = available_rows > len(rows)
    note = "Actual XBRL facts reported in annual or quarterly SEC filings; values are not analyst consensus. Later-filed amendments replace the same reported period when available."
    scope: dict[str, object] = {"provider": "SEC EDGAR", "cik": resolved_cik, "symbol": resolved_symbol or "", "taxonomies": ["us-gaap"], "returnedRows": len(rows)}
    if truncated:
        note = f"{note} Displayed {len(rows)} of {available_rows} distinct reported facts; results are truncated."
        scope.update({"availableRows": available_rows, "displayLimit": _SEC_FACT_ROW_LIMIT})
    return _payload("sec_financials", title="SEC 보고 재무 수치", market="US", source=_SEC_SOURCE, status="snapshot" if rows else "missing", note=note, complete=not truncated, columns=_FINANCIAL_COLUMNS, rows=rows, parameters=parameters, scope=scope, as_of=max((str(row["filed"]) for row in rows), default=None))


_DART_COLUMNS = _columns(
    ("filed", "Filed", False, None), ("reportName", "Report", False, None), ("filingNo", "Receipt number", False, None),
    ("company", "Company", False, None), ("officialURL", "Official filing", False, None),
)


def _dart_code(value: str) -> str:
    code = str(value or "").strip()
    if not _CORP_CODE.fullmatch(code):
        raise ValueError("DART corp_code must contain eight digits")
    return code


def _dart_period(value: str) -> str:
    year = str(value or "").strip()
    if not _YEAR.fullmatch(year) or not 2015 <= int(year) <= datetime.now(timezone.utc).year + 1:
        raise ValueError("DART report_period must be a supported calendar year YYYY")
    return year


def _dart_report_code(value: str) -> str:
    code = str(value or "").strip()
    if code not in _DART_REPORT_CODES:
        raise ValueError("DART report_code must be one documented periodic-report code")
    return code


def _dart_fs_div(value: str) -> str:
    division = str(value or "").strip().upper()
    if division not in _DART_FS_DIVS:
        raise ValueError("DART fs_div must be CFS or OFS")
    return division


def _dart_key(value: str | None) -> str | None:
    if value is None or not str(value).strip():
        return None
    key = str(value).strip()
    if not _DART_KEY.fullmatch(key):
        raise ValueError("DART API key must be a 40-character alphanumeric key")
    return key


def _dart_disclosures(*, corp_code: str | None, report_period: str | None, dart_api_key: str | None) -> dict[str, object]:
    parameters = {"corpCode": str(corp_code or ""), "reportPeriod": str(report_period or ""), "dartApiKeyRequired": True}
    key = _dart_key(dart_api_key)
    if key is None:
        return _setup("dart_disclosures", title="OpenDART 공시", market="KR", source=_DART_SOURCE, note="OpenDART requires the user's own API key. Supply it explicitly per call; this module does not read or persist it.", columns=_DART_COLUMNS, parameters=parameters)
    code, year = _dart_code(corp_code or ""), _dart_period(report_period or "")
    try:
        # Do not cache an API-key-authorized response across callers: keeping
        # a key (or a key-derived cache key) would unnecessarily retain a
        # credential. SEC public metadata is cached separately above.
        query = urlencode({"crtfc_key": key, "corp_code": code, "bgn_de": f"{year}0101", "end_de": f"{year}1231", "page_no": "1", "page_count": "100", "sort": "date", "sort_mth": "desc"})
        payload = _fetch_json(f"https://{_DART_API_HOST}/api/list.json?{query}", headers={"Accept": "application/json", "User-Agent": "kiwoom-mac-trading-company-data/1.0 (read-only)"}, max_bytes=_DART_MAX_BYTES)
    except CompanyDataUnavailable as error:
        return _failure("dart_disclosures", title="OpenDART 공시", market="KR", source=_DART_SOURCE, error=error, columns=_DART_COLUMNS, parameters=parameters)
    if str(payload.get("status") or "") != "000":
        return _payload("dart_disclosures", title="OpenDART 공시", market="KR", source=_DART_SOURCE, status="error", note=f"OpenDART reported status {str(payload.get('status') or 'unknown')[:12]}. Check the supplied key and official service status.", complete=False, columns=_DART_COLUMNS, rows=[], parameters=parameters, scope={"provider": "OpenDART", "corpCode": code, "reportPeriod": year})
    raw_rows = payload.get("list")
    if not isinstance(raw_rows, list):
        return _failure("dart_disclosures", title="OpenDART 공시", market="KR", source=_DART_SOURCE, error=CompanyDataUnavailable(), columns=_DART_COLUMNS, parameters=parameters)
    rows: list[dict[str, object]] = []
    for entry in raw_rows[:100]:
        if not isinstance(entry, dict):
            continue
        receipt, filed = str(entry.get("rcept_no") or ""), str(entry.get("rcept_dt") or "")
        if not _RECEIPT.fullmatch(receipt) or not re.fullmatch(r"\d{8}", filed):
            continue
        rows.append({"id": receipt, "filed": filed, "reportName": _safe_text(entry.get("report_nm")), "filingNo": receipt, "company": _safe_text(entry.get("corp_name"), 160), "officialURL": f"https://{_DART_VIEWER_HOST}/dsaf001/main.do?rcpNo={receipt}"})
    total_pages = payload.get("total_page")
    complete = str(total_pages or "1") in {"", "1"}
    return _payload("dart_disclosures", title="OpenDART 공시", market="KR", source=_DART_SOURCE, status="snapshot" if rows else "missing", note="Official OpenDART disclosures for the requested calendar filing period. Only the first official result page (up to 100 rows) is requested.", complete=complete, columns=_DART_COLUMNS, rows=rows, parameters=parameters, scope={"provider": "OpenDART", "corpCode": code, "reportPeriod": year, "returnedRows": len(rows), "page": 1}, as_of=rows[0]["filed"] if rows else None)


_DART_FINANCIAL_COLUMNS = _columns(
    ("receiptNo", "Receipt number", False, None), ("officialURL", "Official filing", False, None),
    ("businessYear", "Business year", False, None), ("reportCode", "Report code", False, None),
    ("fsDiv", "Statement scope", False, None), ("fsName", "Statement scope name", False, None),
    ("statementCode", "Statement code", False, None), ("statementName", "Statement", False, None),
    ("accountId", "Account ID", False, None), ("accountName", "Account", False, None),
    ("accountDetail", "Account detail", False, None), ("currentTerm", "Current term", False, None),
    ("currentDate", "Current date/period", False, None), ("currentAmount", "Current amount (reported)", False, None),
    ("currentAccumulatedAmount", "Current accumulated amount (reported)", False, None),
    ("previousTerm", "Previous term", False, None), ("previousDate", "Previous date/period", False, None),
    ("previousAmount", "Previous amount (reported)", False, None),
    ("previousQuarterTerm", "Previous comparable term", False, None),
    ("previousQuarterAmount", "Previous comparable amount (reported)", False, None),
    ("previousAccumulatedAmount", "Previous accumulated amount (reported)", False, None),
    ("earlierTerm", "Earlier term", False, None), ("earlierAmount", "Earlier amount (reported)", False, None),
    ("order", "Account order", False, None), ("currency", "Currency", False, None),
)


def _dart_financials(*, corp_code: str | None, report_year: str | None, report_code: str | None, fs_div: str | None, dart_api_key: str | None) -> dict[str, object]:
    parameters = {
        "corpCode": str(corp_code or ""), "reportYear": str(report_year or ""),
        "reportCode": str(report_code or ""), "fsDiv": str(fs_div or ""), "dartApiKeyRequired": True,
    }
    key = _dart_key(dart_api_key)
    if key is None:
        return _setup("dart_financials", title="OpenDART 전체 재무제표", market="KR", source=_DART_SOURCE, note="OpenDART requires the user's own API key. Configure it locally; this module does not read or persist it.", columns=_DART_FINANCIAL_COLUMNS, parameters=parameters)
    code, year = _dart_code(corp_code or ""), _dart_period(report_year or "")
    report, division = _dart_report_code(report_code or ""), _dart_fs_div(fs_div or "")
    try:
        query = urlencode({"crtfc_key": key, "corp_code": code, "bsns_year": year, "reprt_code": report, "fs_div": division})
        payload = _fetch_json(f"https://{_DART_API_HOST}/api/fnlttSinglAcntAll.json?{query}", headers={"Accept": "application/json", "User-Agent": "kiwoom-mac-trading-company-data/1.0 (read-only)"}, max_bytes=_DART_FINANCIAL_MAX_BYTES)
    except CompanyDataUnavailable as error:
        return _failure("dart_financials", title="OpenDART 전체 재무제표", market="KR", source=_DART_SOURCE, error=error, columns=_DART_FINANCIAL_COLUMNS, parameters=parameters)
    status = str(payload.get("status") or "")
    scope = {
        "provider": "OpenDART", "corpCode": code, "businessYear": year,
        "reportCode": report, "reportKind": _DART_REPORT_CODES[report], "fsDiv": division,
        "statementScope": _DART_FS_DIVS[division],
    }
    if status == "013":
        return _payload("dart_financials", title="OpenDART 전체 재무제표", market="KR", source=_DART_SOURCE, status="missing", note="OpenDART reported no financial-statement data for the requested company, year, report code, and statement scope.", complete=True, columns=_DART_FINANCIAL_COLUMNS, rows=[], parameters=parameters, scope=scope)
    if status != "000":
        return _payload("dart_financials", title="OpenDART 전체 재무제표", market="KR", source=_DART_SOURCE, status="error", note=f"OpenDART reported status {status[:12] or 'unknown'}. Check the saved key and official service status.", complete=False, columns=_DART_FINANCIAL_COLUMNS, rows=[], parameters=parameters, scope=scope)
    entries = payload.get("list")
    if not isinstance(entries, list):
        return _failure("dart_financials", title="OpenDART 전체 재무제표", market="KR", source=_DART_SOURCE, error=CompanyDataUnavailable(), columns=_DART_FINANCIAL_COLUMNS, parameters=parameters)
    rows: list[dict[str, object]] = []
    for index, entry in enumerate(entries[:_DART_FINANCIAL_ROW_LIMIT]):
        if not isinstance(entry, dict):
            continue
        receipt = str(entry.get("rcept_no") or "")
        account_name = _safe_text(entry.get("account_nm"), 220)
        if not _RECEIPT.fullmatch(receipt) or not account_name:
            continue
        account_id = _safe_text(entry.get("account_id"), 180)
        account_order = _safe_text(entry.get("ord"), 24)
        rows.append({
            "id": f"{receipt}:{_safe_text(entry.get('fs_div'), 8)}:{_safe_text(entry.get('sj_div'), 16)}:{account_id or account_name}:{account_order}:{index}",
            "receiptNo": receipt, "officialURL": f"https://{_DART_VIEWER_HOST}/dsaf001/main.do?rcpNo={receipt}",
            "businessYear": _safe_text(entry.get("bsns_year"), 8) or year, "reportCode": _safe_text(entry.get("reprt_code"), 8) or report,
            "fsDiv": _safe_text(entry.get("fs_div"), 8) or division, "fsName": _safe_text(entry.get("fs_nm"), 120),
            "statementCode": _safe_text(entry.get("sj_div"), 16), "statementName": _safe_text(entry.get("sj_nm"), 120),
            "accountId": account_id, "accountName": account_name, "accountDetail": _safe_text(entry.get("account_detail"), 300),
            "currentTerm": _safe_text(entry.get("thstrm_nm"), 120), "currentDate": _safe_text(entry.get("thstrm_dt"), 120),
            "currentAmount": _safe_text(entry.get("thstrm_amount"), 80), "currentAccumulatedAmount": _safe_text(entry.get("thstrm_add_amount"), 80),
            "previousTerm": _safe_text(entry.get("frmtrm_nm"), 120), "previousDate": _safe_text(entry.get("frmtrm_dt"), 120),
            "previousAmount": _safe_text(entry.get("frmtrm_amount"), 80), "previousQuarterTerm": _safe_text(entry.get("frmtrm_q_nm"), 120),
            "previousQuarterAmount": _safe_text(entry.get("frmtrm_q_amount"), 80), "previousAccumulatedAmount": _safe_text(entry.get("frmtrm_add_amount"), 80),
            "earlierTerm": _safe_text(entry.get("bfefrmtrm_nm"), 120), "earlierAmount": _safe_text(entry.get("bfefrmtrm_amount"), 80),
            "order": account_order, "currency": _safe_text(entry.get("currency"), 24),
        })
    truncated = len(entries) > _DART_FINANCIAL_ROW_LIMIT
    next_scope = {**scope, "returnedRows": len(rows)}
    note = "Official reported account values are shown as returned, without ratios or derived values. Later corrected filings may change the reported values; verify the receipt number and official filing."
    if truncated:
        next_scope.update({"availableRows": len(entries), "displayLimit": _DART_FINANCIAL_ROW_LIMIT})
        note = f"{note} Displayed {len(rows)} of {len(entries)} provider rows; results are truncated."
    return _payload("dart_financials", title="OpenDART 전체 재무제표", market="KR", source=_DART_SOURCE, status="snapshot" if rows else "missing", note=note, complete=not truncated, columns=_DART_FINANCIAL_COLUMNS, rows=rows, parameters=parameters, scope=next_scope)


def feature_metadata(feature_id: str | None = None) -> dict[str, object] | list[dict[str, object]]:
    """Return copy-safe feature metadata for route/UI integration."""
    if feature_id is None:
        return [copy.deepcopy(FEATURE_REGISTRY[key]) for key in sorted(FEATURE_REGISTRY)]
    if feature_id not in FEATURE_REGISTRY:
        raise ValueError("unknown company-data feature")
    return copy.deepcopy(FEATURE_REGISTRY[feature_id])


def _fixture(feature_id: str) -> dict[str, object]:
    """Deterministic fixture output; it deliberately never validates or uses keys."""
    if feature_id == "sec_filings":
        return _payload(feature_id, title="SEC 최근 공시", market="US", source="fixture", status="fixture", note="Deterministic fixture data; no SEC request was made.", complete=True, columns=_FILING_COLUMNS, rows=[{"id": "fixture-sec-filing", "filed": "2026-01-30", "reportDate": "2025-12-31", "form": "10-K", "accession": "0000000000-26-000001", "officialURL": ""}], parameters={"fixture": True}, scope={"provider": "fixture"}, as_of="2026-01-30")
    if feature_id == "sec_financials":
        return _payload(feature_id, title="SEC 보고 재무 수치", market="US", source="fixture", status="fixture", note="Deterministic fixture data; no SEC request was made.", complete=True, columns=_FINANCIAL_COLUMNS, rows=[{"id": "fixture-revenue", "metric": "Revenue", "periodType": "annual", "fiscalYear": 2025, "fiscalPeriod": "FY", "reportStart": "2025-01-01", "reportEnd": "2025-12-31", "periodKind": "duration", "periodDays": 364, "filed": "2026-01-30", "form": "10-K", "amendment": False, "unit": "USD", "value": 1000000}], parameters={"fixture": True}, scope={"provider": "fixture"}, as_of="2026-01-30")
    if feature_id == "dart_disclosures":
        return _payload(feature_id, title="OpenDART 공시", market="KR", source="fixture", status="fixture", note="Deterministic fixture data; no OpenDART request was made.", complete=True, columns=_DART_COLUMNS, rows=[{"id": "20260130000001", "filed": "20260130", "reportName": "사업보고서", "filingNo": "20260130000001", "company": "테스트 법인", "officialURL": ""}], parameters={"fixture": True}, scope={"provider": "fixture"}, as_of="20260130")
    if feature_id == "dart_financials":
        return _payload(feature_id, title="OpenDART 전체 재무제표", market="KR", source="fixture", status="fixture", note="Deterministic fixture data; no OpenDART request was made.", complete=True, columns=_DART_FINANCIAL_COLUMNS, rows=[{"id": "fixture-dart-financial", "receiptNo": "20260130000001", "officialURL": "", "businessYear": "2025", "reportCode": "11011", "fsDiv": "CFS", "fsName": "연결재무제표", "statementCode": "BS", "statementName": "재무상태표", "accountId": "ifrs-full_Assets", "accountName": "자산총계", "accountDetail": "", "currentTerm": "제 1 기말", "currentDate": "2025.12.31", "currentAmount": "1000000", "currentAccumulatedAmount": "", "previousTerm": "전기말", "previousDate": "2024.12.31", "previousAmount": "900000", "previousQuarterTerm": "", "previousQuarterAmount": "", "previousAccumulatedAmount": "", "earlierTerm": "", "earlierAmount": "", "order": "1", "currency": "KRW"}], parameters={"fixture": True}, scope={"provider": "fixture"})
    raise ValueError("unknown company-data feature")


def _query_params(feature_id: str, params: dict[str, object] | None) -> dict[str, object]:
    if params is None:
        return {}
    if not isinstance(params, dict) or any(not isinstance(key, str) for key in params):
        raise ValueError("company-data parameters must be a string-keyed mapping")
    allowed = {str(parameter["key"]) for parameter in FEATURES[feature_id]["parameters"]}  # type: ignore[index]
    if set(params) - allowed:
        raise ValueError("unsupported company-data parameter")
    return dict(params)


def _query_limit(value: object | None) -> int:
    if value is None or value == "":
        return 20
    if isinstance(value, bool):
        raise ValueError("limit must be an integer from 1 through 100")
    if isinstance(value, str):
        if not re.fullmatch(r"\d{1,3}", value):
            raise ValueError("limit must be an integer from 1 through 100")
        value = int(value)
    if not isinstance(value, int) or not 1 <= value <= 100:
        raise ValueError("limit must be an integer from 1 through 100")
    return value


def _instrument_symbol(instrument: dict[str, object] | None) -> str | None:
    if not isinstance(instrument, dict):
        return None
    value = instrument.get("stkCd")
    return str(value) if value else None


def _instrument_environment(instrument: dict[str, object] | None, environment: str | None) -> str:
    chosen = environment
    if chosen is None and isinstance(instrument, dict):
        raw = instrument.get("environment")
        chosen = str(raw) if raw else None
    chosen = chosen or "real"
    if chosen not in {"fixture", "demo", "real"}:
        raise ValueError("unsupported company-data environment")
    return chosen


def get_feature(feature_id: str, params: dict[str, object] | None = None, *, instrument: dict[str, object] | None = None, symbol: str | None = None, cik: str | int | None = None, limit: int | str | None = None, sec_user_agent: str | None = None, corp_code: str | None = None, report_period: str | None = None, report_year: str | None = None, report_code: str | None = None, fs_div: str | None = None, dart_api_key: str | None = None, environment: str | None = None) -> dict[str, object]:
    """Fetch one bounded, official company/disclosure feature.

    No caller-controlled URL, broker client, account identifier, environment
    read, or secret persistence is involved. Invalid inputs fail before I/O.
    """
    if feature_id not in FEATURES:
        raise ValueError("unknown company-data feature")
    supplied = _query_params(feature_id, params)
    resolved_environment = _instrument_environment(instrument, environment)
    if resolved_environment == "fixture":
        return _fixture(feature_id)
    if feature_id == "sec_filings":
        return _sec_filings(
            symbol=symbol if symbol is not None else str(supplied.get("symbol") or _instrument_symbol(instrument) or "") or None,
            cik=cik if cik is not None else supplied.get("cik"),
            limit=_query_limit(limit if limit is not None else supplied.get("limit")),
            sec_user_agent=sec_user_agent,
        )
    if feature_id == "sec_financials":
        return _sec_financials(
            symbol=symbol if symbol is not None else str(supplied.get("symbol") or _instrument_symbol(instrument) or "") or None,
            cik=cik if cik is not None else supplied.get("cik"),
            sec_user_agent=sec_user_agent,
        )
    if feature_id == "dart_disclosures":
        return _dart_disclosures(
            corp_code=corp_code if corp_code is not None else (str(supplied["corpCode"]) if supplied.get("corpCode") else None),
            report_period=report_period if report_period is not None else (str(supplied["reportPeriod"]) if supplied.get("reportPeriod") else None),
            dart_api_key=dart_api_key,
        )
    if feature_id == "dart_financials":
        return _dart_financials(
            corp_code=corp_code if corp_code is not None else (str(supplied["corpCode"]) if supplied.get("corpCode") else None),
            report_year=report_year if report_year is not None else (str(supplied["reportYear"]) if supplied.get("reportYear") else None),
            report_code=report_code if report_code is not None else (str(supplied["reportCode"]) if supplied.get("reportCode") else None),
            fs_div=fs_div if fs_div is not None else (str(supplied["fsDiv"]) if supplied.get("fsDiv") else None),
            dart_api_key=dart_api_key,
        )
    raise AssertionError("validated company-data feature was not dispatched")


def _clear_caches_for_tests() -> None:
    global _NEXT_REQUEST_AT
    with _CACHE_LOCK:
        _CACHE.clear()
    with _PACE_LOCK:
        _NEXT_REQUEST_AT = 0.0
