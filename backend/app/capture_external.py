"""Bounded public supplemental feeds for the captured 0200 and 0700 screens.

This module intentionally has no relationship to the broker client: every
upstream URL is a constant, callers cannot supply a URL, redirects are
disabled, and fixture/demo calls never make network requests.  Public feeds
can be delayed, unavailable, or change their response shape, so incomplete
results are represented in the documented capture payload rather than filled
with invented values.
"""
from __future__ import annotations

import copy
import hashlib
import html
import json
import math
import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from threading import BoundedSemaphore, Event, Lock
from typing import TypeAlias
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


CapturePayload: TypeAlias = dict[str, object]
Section: TypeAlias = dict[str, object]

_HTTP_TIMEOUT_SECONDS = 5.0
_NEWS_PROVIDER_TIMEOUT_SECONDS = 4.0
_NEWS_DEADLINE_SECONDS = 10.0
_GLOBAL_PROVIDER_TIMEOUT_SECONDS = 4.0
_GLOBAL_DEADLINE_SECONDS = 8.0
_RSS_MAX_BYTES = 768 * 1024
_QUOTE_MAX_BYTES = 196 * 1024
_NEWS_TTL_SECONDS = 90.0
_GLOBAL_TTL_SECONDS = 60.0
_CACHE_LIMIT = 48
_PUBLIC_HOSTS = {
    "feeds.bbci.co.uk",
    "feeds.npr.org",
    "en.yna.co.kr",
    "www.mk.co.kr",
    "www.hankyung.com",
    "news.google.com",
    "query2.finance.yahoo.com",
}
_ALLOWED_ENVIRONMENTS = {"real", "fixture", "demo"}
_QUERY_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_RSS_COLON_OFFSET = re.compile(r"(?P<hours>[+-]\d{2}):(?P<minutes>\d{2})$")
_RSS_KST = re.compile(r"\bKST\b", re.IGNORECASE)
_CACHE_LOCK = Lock()
_CACHE: dict[tuple[object, ...], tuple[float, object]] = {}
# The pool is deliberately process-wide.  A request acquires a slot before it
# submits work, so it cannot build an executor queue while another request is
# slow.  We never use this executor as a context manager: ``__exit__`` waits
# for every worker and would defeat the request deadline when a provider is
# unresponsive.
_NEWS_POOL = ThreadPoolExecutor(max_workers=3, thread_name_prefix="public-news")
_NEWS_WORKER_SLOTS = BoundedSemaphore(3)
_NEWS_RUN_LOCK = Lock()
_NEWS_RUNS: dict[tuple[object, ...], Event] = {}
# Market quotes have their own small process-wide budget so a stalled 0200
# source cannot consume the independent RSS screen's three worker slots.
_GLOBAL_POOL = ThreadPoolExecutor(max_workers=3, thread_name_prefix="public-market")
_GLOBAL_WORKER_SLOTS = BoundedSemaphore(3)
_GLOBAL_RUN_LOCK = Lock()
_GLOBAL_RUNS: dict[tuple[object, ...], Event] = {}


class _NoRedirect(HTTPRedirectHandler):
    """Reject redirects rather than making a server-selected second request."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


class _HTMLText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        return " ".join(" ".join(self.parts).split())


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _as_utc(value: object) -> str | None:
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    try:
        return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return None


def _finite(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _plain_text(value: object, *, maximum: int) -> str:
    parser = _HTMLText()
    try:
        parser.feed(html.unescape(str(value or "")))
        parser.close()
        text = parser.text()
    except Exception:
        text = " ".join(str(value or "").split())
    return text[:maximum].rstrip()


def _cache_get(key: tuple[object, ...]) -> object | None:
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached is None or cached[0] <= time.monotonic():
            _CACHE.pop(key, None)
            return None
        return copy.deepcopy(cached[1])


def _cache_put(key: tuple[object, ...], value: object, ttl: float) -> object:
    with _CACHE_LOCK:
        if key not in _CACHE and len(_CACHE) >= _CACHE_LIMIT:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = (time.monotonic() + ttl, copy.deepcopy(value))
    return copy.deepcopy(value)


def _fixed_public_url(url: str) -> None:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ValueError("external URL is not allowlisted") from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname not in _PUBLIC_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
        or not parsed.path.startswith("/")
    ):
        raise ValueError("external URL is not allowlisted")


def _urllib_transport(url: str, *, timeout: float, max_bytes: int) -> bytes:
    """Fetch a hardcoded feed with no redirects and a bounded body."""
    _fixed_public_url(url)
    request = Request(
        url,
        headers={
            "Accept": "application/rss+xml, application/xml, application/json;q=0.9",
            "User-Agent": "kiwoom-mac-trading-capture/1.0 (read-only)",
        },
    )
    opener = build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            length = response.headers.get("Content-Length")
            if length is not None and int(length) > max_bytes:
                raise ValueError("external response exceeds limit")
            body = response.read(max_bytes + 1)
    except (HTTPError, URLError, OSError, ValueError) as exc:
        raise RuntimeError("external feed unavailable") from exc
    if len(body) > max_bytes:
        raise RuntimeError("external response exceeds limit")
    return body


# Tests replace this function.  It receives only module-owned, allowlisted URLs.
_transport = _urllib_transport


def _fetch_bytes(url: str, *, max_bytes: int, timeout: float = _HTTP_TIMEOUT_SECONDS) -> bytes:
    _fixed_public_url(url)
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("external timeout must be positive")
    body = _transport(url, timeout=float(timeout), max_bytes=max_bytes)
    if not isinstance(body, bytes) or len(body) > max_bytes:
        raise RuntimeError("external response exceeds limit")
    return body


def _environment(value: str) -> str:
    normalized = str(value or "").lower()
    if normalized not in _ALLOWED_ENVIRONMENTS:
        raise ValueError("unsupported capture environment")
    return normalized


def _query(value: str) -> str:
    if not isinstance(value, str) or _QUERY_CONTROL.search(value) or len(value) > 100:
        raise ValueError("query must be plain text of at most 100 characters")
    return " ".join(value.split())


_NEWS_FEEDS = {
    # ``all`` is intentionally Korean stock/economy coverage first: 0700 is a
    # captured domestic HTS screen.  International feeds remain opt-in IDs.
    "mk_stock": {
        "url": "https://www.mk.co.kr/rss/50200011/",
        "label": "매일경제 증권 RSS (발행사)",
        "link_hosts": {"www.mk.co.kr"},
        "default": True,
    },
    "hankyung_finance": {
        "url": "https://www.hankyung.com/feed/finance",
        "label": "한국경제 금융 RSS (발행사)",
        "link_hosts": {"www.hankyung.com"},
        "default": True,
    },
    "mk_economy": {
        "url": "https://www.mk.co.kr/rss/30100041/",
        "label": "매일경제 경제 RSS (발행사)",
        "link_hosts": {"www.mk.co.kr"},
        "default": True,
    },
    "google": {
        "url": "https://news.google.com/rss/search",
        "label": "Google News RSS 검색 (집계; 링크는 Google News 결과)",
        "link_hosts": {"news.google.com"},
        "default": False,
        "search_when_query": True,
        "aggregator": True,
    },
    "bbc": {
        "url": "https://feeds.bbci.co.uk/news/business/rss.xml",
        "label": "BBC News Business RSS (발행사)",
        "link_hosts": {"www.bbc.com", "www.bbc.co.uk"},
        "default": False,
    },
    "npr": {
        "url": "https://feeds.npr.org/1006/rss.xml",
        "label": "NPR Business RSS (발행사)",
        "link_hosts": {"www.npr.org", "text.npr.org"},
        "default": False,
    },
    "yonhap": {
        "url": "https://en.yna.co.kr/RSS/news.xml",
        "label": "연합뉴스 RSS (발행사)",
        "link_hosts": {"en.yna.co.kr"},
        "default": False,
    },
}


def _provider(value: str) -> str:
    normalized = str(value or "all").lower()
    if normalized not in {"all", *_NEWS_FEEDS}:
        raise ValueError("unsupported news provider")
    return normalized


def _google_search_url(query: str) -> str:
    """Construct the sole dynamic public URL from a prevalidated search term."""
    # The only caller-derived portion is an RFC 3986 encoded ``q`` value; the
    # host, path, locale and all other parameters are fixed module constants.
    return "https://news.google.com/rss/search?" + urlencode(
        {"q": query, "hl": "ko", "gl": "KR", "ceid": "KR:ko"}, quote_via=quote
    )


def _xml_child_text(item: ET.Element, name: str) -> str:
    for child in item:
        if child.tag.rsplit("}", 1)[-1] == name:
            return "".join(child.itertext()).strip()
    return ""


def _rss_date(value: str) -> str:
    try:
        raw = str(value or "").strip()
        # The live Maeil RSS uses the valid ``+09:00`` offset spelling, but
        # Python's email parser silently returns it as naive. Normalize only
        # that explicit numeric offset; other aware timestamps stay intact.
        normalized = _RSS_COLON_OFFSET.sub(r"\g<hours>\g<minutes>", raw)
        parsed = parsedate_to_datetime(normalized)
        if parsed.tzinfo is None:
            # KST is an explicit source declaration, not a locale guess.
            parsed = parsed.replace(tzinfo=timezone(timedelta(hours=9)) if _RSS_KST.search(raw) else timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, IndexError, OverflowError):
        return ""


def _safe_original_url(value: str, hosts: set[str]) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        return ""
    if (
        parsed.scheme != "https"
        or parsed.hostname not in hosts
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
        or not parsed.path.startswith("/")
        or len(value) > 2048
    ):
        return ""
    return value


def _parse_feed(payload: bytes, feed: dict[str, object], query: str) -> list[dict[str, str]]:
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        raise RuntimeError("malformed publisher RSS") from exc
    label = str(feed["label"])
    hosts = set(feed["link_hosts"])  # fixed module metadata, not input
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in root.findall(".//item"):
        title = _plain_text(_xml_child_text(item, "title"), maximum=300)
        url = _safe_original_url(_xml_child_text(item, "link"), hosts)
        if not title or not url or url in seen:
            continue
        summary = _plain_text(_xml_child_text(item, "description"), maximum=500)
        # Google applies the encoded query upstream.  Applying a second text
        # filter would incorrectly discard valid results whose title/snippet
        # uses a different script, ticker notation, or publisher wording.
        if query and not bool(feed.get("aggregator")) and query.casefold() not in f"{title} {summary}".casefold():
            continue
        seen.add(url)
        published = _rss_date(_xml_child_text(item, "pubDate") or _xml_child_text(item, "date"))
        provider = label
        if bool(feed.get("aggregator")):
            upstream = _plain_text(_xml_child_text(item, "source"), maximum=120)
            if upstream:
                provider = f"{label}; 발행사 메타데이터: {upstream}"
        digest = hashlib.sha256(f"{provider}\0{url}".encode("utf-8")).hexdigest()[:24]
        result.append(
            {
                "id": f"rss-{digest}",
                "title": title,
                "provider": provider,
                "publishedAt": published,
                "url": url,
                "summary": summary,
            }
        )
    return result


_FIXTURE_NEWS = [
    {
        "id": "fixture-news-1",
        "title": "테스트 시장 헤드라인",
        "provider": "테스트 발행사 데이터 (합성)",
        "publishedAt": "2026-10-24T00:00:00Z",
        "url": "https://example.invalid/capture-fixture-news-1",
        "summary": "결정적 테스트 요약이며 외부 기사가 아닙니다.",
    }
]


def _fixture_news(environment: str, query: str) -> CapturePayload:
    items = [row for row in _FIXTURE_NEWS if not query or query.casefold() in row["title"].casefold()]
    return {
        "screen": "0700",
        "title": "뉴스",
        "source": "fixture",
        "status": "fixture",
        "environment": environment,
        "receivedAt": "2026-10-24T00:00:00Z",
        "asOf": items[0]["publishedAt"] if items else None,
        "note": "결정적 테스트 데이터이며 외부 요청을 하지 않습니다.",
        "complete": True,
        "columns": [
            {"key": "publishedAt", "label": "발행 시각"},
            {"key": "provider", "label": "제공처"},
            {"key": "title", "label": "제목"},
        ],
        "rows": [],
        "news": copy.deepcopy(items),
    }


def _selected_news_feeds(provider: str, query: str) -> list[tuple[str, dict[str, object]]]:
    if provider == "all":
        return [
            (name, feed)
            for name, feed in _NEWS_FEEDS.items()
            if bool(feed["default"]) or (bool(query) and bool(feed.get("search_when_query")))
        ]
    return [(provider, _NEWS_FEEDS[provider])]


def _load_news_feed(
    name: str, feed: dict[str, object], query: str, timeout: float
) -> tuple[str, str, list[dict[str, str]] | None]:
    """Fetch one fixed feed and always release the process-wide worker slot."""
    try:
        url = _google_search_url(query) if name == "google" else str(feed["url"])
        return name, str(feed["label"]), _parse_feed(
            _fetch_bytes(url, max_bytes=_RSS_MAX_BYTES, timeout=timeout), feed, query
        )
    except Exception:
        return name, str(feed["label"]), None
    finally:
        _NEWS_WORKER_SLOTS.release()


def _submit_news_feed(
    name: str, feed: dict[str, object], query: str, deadline: float
) -> Future[tuple[str, str, list[dict[str, str]] | None]] | None:
    """Submit only immediately runnable work; never create a provider queue."""
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not _NEWS_WORKER_SLOTS.acquire(blocking=False):
        return None
    try:
        return _NEWS_POOL.submit(
            _load_news_feed,
            name,
            feed,
            query,
            min(_NEWS_PROVIDER_TIMEOUT_SECONDS, remaining),
        )
    except Exception:
        _NEWS_WORKER_SLOTS.release()
        return None


def _news_result(
    *,
    query: str,
    provider: str,
    articles: list[dict[str, str]],
    succeeded: list[str],
    failed: list[str],
    timed_out: list[str],
    capacity_skipped: list[str],
) -> CapturePayload:
    deduped = {article["url"]: article for article in articles}
    news = sorted(deduped.values(), key=lambda row: row["publishedAt"], reverse=True)[:36]
    status = "snapshot" if news else ("missing" if succeeded else "error")
    notes = ["발행사 RSS의 제목과 요약만 제공하며 기사 본문은 가져오지 않습니다."]
    if failed:
        notes.append(f"사용할 수 없는 발행사 피드: {', '.join(failed)}.")
    if timed_out:
        notes.append(f"10초 뉴스 집계 제한으로 다음 피드를 기다리지 않고 부분 결과를 반환했습니다: {', '.join(timed_out)}.")
    if capacity_skipped:
        notes.append(f"전역 동시 조회 제한으로 이번 요청에서 시작하지 못한 피드: {', '.join(capacity_skipped)}.")
    if query and provider != "google":
        notes.append("검색어는 고정 발행사 피드에 로컬 필터로 적용됩니다.")
    if provider == "google" or (provider == "all" and query):
        notes.append(
            "Google News 결과는 검색 집계이며 시각은 원문 발행 시각이 아닐 수 있고 링크는 Google News 결과 링크입니다."
        )
        notes.append("Google News RSS에는 개인·비상업적 피드 리더 이용 약관이 표시됩니다.")
    return {
        "screen": "0700",
        "title": "뉴스",
        "source": "; ".join(succeeded) if succeeded else "공개 발행사 RSS",
        "status": status,
        "environment": "real",
        "receivedAt": _utc_now(),
        "asOf": news[0]["publishedAt"] if news and news[0]["publishedAt"] else None,
        "note": " ".join(notes),
        "complete": not failed and not timed_out and not capacity_skipped,
        "columns": [
            {"key": "publishedAt", "label": "발행 시각"},
            {"key": "provider", "label": "제공처"},
            {"key": "title", "label": "제목"},
        ],
        "rows": [],
        "news": news,
    }


def _collect_news(query: str, provider: str) -> CapturePayload:
    """Collect an RSS snapshot before a hard wall-clock deadline.

    Futures that ignore their transport timeout may outlive this method, but
    their slots stay occupied until they finish.  The request returns at the
    deadline and never enters an executor shutdown/wait path.
    """
    deadline = time.monotonic() + _NEWS_DEADLINE_SECONDS
    pending = _selected_news_feeds(provider, query)
    feed_order = [name for name, _ in pending]
    active: dict[Future[tuple[str, str, list[dict[str, str]] | None]], str] = {}
    articles_by_feed: dict[str, list[dict[str, str]]] = {}
    succeeded: dict[str, str] = {}
    failed: set[str] = set()
    timed_out: list[str] = []
    capacity_skipped: list[str] = []

    while pending or active:
        while pending and time.monotonic() < deadline:
            name, feed = pending[0]
            future = _submit_news_feed(name, feed, query, deadline)
            if future is None:
                break
            pending.pop(0)
            active[future] = name

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out.extend(active.values())
            timed_out.extend(name for name, _ in pending)
            # Do not cancel: a just-submitted future may not have entered
            # _load_news_feed yet, where its acquired semaphore slot is
            # released.  At most three such futures exist globally.
            break
        if not active:
            # Slots held by another aggregation are intentionally not queued
            # here; returning now keeps retries bounded as well.
            capacity_skipped.extend(name for name, _ in pending)
            break

        done, _ = wait(active, timeout=remaining, return_when=FIRST_COMPLETED)
        if not done:
            timed_out.extend(active.values())
            timed_out.extend(name for name, _ in pending)
            # See the deadline branch above: letting bounded outstanding work
            # start/finish is required to release its worker slot exactly once.
            break
        for future in done:
            name = active.pop(future)
            try:
                loaded_name, label, items = future.result()
            except Exception:
                failed.add(name)
                continue
            if items is None:
                failed.add(loaded_name)
            else:
                succeeded[loaded_name] = label
                articles_by_feed[loaded_name] = items

    def in_feed_order(values: list[str] | set[str]) -> list[str]:
        selected = set(values)
        return [name for name in feed_order if name in selected]

    return _news_result(
        query=query,
        provider=provider,
        articles=[article for name in feed_order for article in articles_by_feed.get(name, [])],
        succeeded=[succeeded[name] for name in feed_order if name in succeeded],
        failed=in_feed_order(failed),
        timed_out=in_feed_order(timed_out),
        capacity_skipped=in_feed_order(capacity_skipped),
    )


def news_snapshot(query: str = "", provider: str = "all", environment: str = "real") -> CapturePayload:
    """Return direct publisher RSS headlines only; never scrape article pages."""
    selected_environment = _environment(environment)
    selected_query = _query(query)
    selected_provider = _provider(provider)
    if selected_environment != "real":
        return _fixture_news(selected_environment, selected_query)
    if selected_provider == "google" and not selected_query:
        raise ValueError("Google News search requires a query")

    key = ("news", selected_provider, selected_query)
    if cached := _cache_get(key):
        return cached  # type: ignore[return-value]
    with _NEWS_RUN_LOCK:
        event = _NEWS_RUNS.get(key)
        leader = event is None
        if leader:
            event = Event()
            _NEWS_RUNS[key] = event
    if not leader:
        # Do not duplicate a cache miss while the same aggregation is already
        # consuming scarce slots.  This wait has the same hard request budget.
        assert event is not None
        event.wait(_NEWS_DEADLINE_SECONDS)
        if cached := _cache_get(key):
            return cached  # type: ignore[return-value]
        return _news_result(
            query=selected_query,
            provider=selected_provider,
            articles=[],
            succeeded=[],
            failed=[],
            timed_out=["same-request"],
            capacity_skipped=[],
        )
    try:
        return _cache_put(key, _collect_news(selected_query, selected_provider), _NEWS_TTL_SECONDS)  # type: ignore[return-value]
    finally:
        with _NEWS_RUN_LOCK:
            _NEWS_RUNS.pop(key, None)
            assert event is not None
            event.set()


_GLOBAL_GROUPS = {
    "global-indices": (
        "글로벌 주요 지수",
        (
            ("^GSPC", "S&P 500"),
            ("^NDX", "NASDAQ-100"),
            ("^N225", "Nikkei 225"),
            ("^FTSE", "FTSE 100"),
        ),
    ),
    "global-fx": (
        "환율 (USD 기준)",
        (("JPY=X", "USD/JPY"), ("KRW=X", "USD/KRW"), ("EURUSD=X", "EUR/USD")),
    ),
    "global-commodities": (
        "원자재 선물",
        (("GC=F", "Gold futures"), ("BZ=F", "Brent crude futures")),
    ),
}


def _quote_url(symbol: str) -> str:
    # ``symbol`` is selected only from _GLOBAL_GROUPS.  No caller input flows
    # into a URL or provider request parameter.
    return f"https://query2.finance.yahoo.com/v8/finance/chart/{quote(symbol, safe='')}?range=5d&interval=1d"


def _quote_row(payload: bytes, symbol: str, name: str) -> dict[str, object] | None:
    try:
        decoded = json.loads(payload.decode("utf-8"))
        result = decoded["chart"]["result"][0]
        meta = result["meta"]
    except (UnicodeDecodeError, ValueError, TypeError, KeyError, IndexError):
        return None
    if not isinstance(meta, dict):
        return None
    last = _finite(meta.get("regularMarketPrice"))
    if last is None:
        return None
    timestamp = _as_utc(meta.get("regularMarketTime"))
    if timestamp is None and isinstance(result.get("timestamp"), list) and result["timestamp"]:
        timestamp = _as_utc(result["timestamp"][-1])
    return {
        "id": f"yahoo-{symbol}",
        "symbol": symbol,
        "name": name,
        "last": last,
        "change": _finite(meta.get("regularMarketChange", meta.get("fulldayChange"))),
        "changePct": _finite(meta.get("regularMarketChangePercent", meta.get("fulldayChangePercent"))),
        "currency": str(meta.get("currency") or ""),
        "asOf": timestamp,
        "marketState": str(meta.get("marketState") or "unknown"),
        "timing": "possibly delayed",
    }


def _global_columns(quote_precision: int) -> list[dict[str, object]]:
    """Return an explicit, provider-owned display contract for global quotes."""
    return [
        {"key": "name", "label": "종목"},
        {"key": "last", "label": "현재가", "numeric": True, "precision": quote_precision},
        {"key": "change", "label": "등락", "numeric": True, "precision": quote_precision},
        {"key": "changePct", "label": "등락률", "unit": "%", "numeric": True, "precision": 2},
        {"key": "currency", "label": "통화"},
        {"key": "asOf", "label": "제공 시각"},
    ]


_GLOBAL_COLUMNS = _global_columns(2)
_GLOBAL_COLUMNS_BY_SECTION = {
    "global-indices": _global_columns(2),
    "global-fx": _global_columns(4),
    "global-commodities": _global_columns(2),
}


def _global_fixture(environment: str) -> list[Section]:
    values = {
        "global-indices": (("^GSPC", "S&P 500", 5900.0), ("^NDX", "NASDAQ-100", 21000.0)),
        "global-fx": (("JPY=X", "USD/JPY", 150.0), ("KRW=X", "USD/KRW", 1350.0)),
        "global-commodities": (("GC=F", "Gold futures", 2400.0), ("BZ=F", "Brent crude futures", 80.0)),
    }
    sections: list[Section] = []
    for section_id, (title, _) in _GLOBAL_GROUPS.items():
        rows = [
            {
                "id": f"fixture-{symbol}",
                "symbol": symbol,
                "name": name,
                "last": last,
                "change": 0.0,
                "changePct": 0.0,
                "currency": "USD",
                "asOf": "2026-10-24T00:00:00Z",
                "marketState": "fixture",
                "timing": "fixture",
            }
            for symbol, name, last in values[section_id]
        ]
        sections.append(
            {
                "id": section_id,
                "title": title,
                "columns": copy.deepcopy(_GLOBAL_COLUMNS_BY_SECTION[section_id]),
                "rows": rows,
                "source": "fixture",
                "status": "fixture",
                "asOf": "2026-10-24T00:00:00Z",
                "note": "결정적 테스트 데이터이며 외부 요청을 하지 않습니다.",
                "complete": True,
            }
        )
    return sections


def _load_global_quote(
    instrument: tuple[str, str], timeout: float
) -> tuple[str, dict[str, object] | None]:
    """Fetch one fixed global quote and always return its reserved slot."""
    symbol, name = instrument
    try:
        return symbol, _quote_row(
            _fetch_bytes(_quote_url(symbol), max_bytes=_QUOTE_MAX_BYTES, timeout=timeout), symbol, name
        )
    except Exception:
        return symbol, None
    finally:
        _GLOBAL_WORKER_SLOTS.release()


def _submit_global_quote(
    instrument: tuple[str, str], deadline: float
) -> Future[tuple[str, dict[str, object] | None]] | None:
    """Reserve a slot before submitting; the executor never receives a backlog."""
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not _GLOBAL_WORKER_SLOTS.acquire(blocking=False):
        return None
    try:
        return _GLOBAL_POOL.submit(
            _load_global_quote,
            instrument,
            min(_GLOBAL_PROVIDER_TIMEOUT_SECONDS, remaining),
        )
    except Exception:
        _GLOBAL_WORKER_SLOTS.release()
        return None


def _global_sections_result(
    quotes: dict[str, dict[str, object]],
    failed: set[str],
    timed_out: set[str],
    capacity_skipped: set[str],
) -> list[Section]:
    sections: list[Section] = []
    for section_id, (title, instruments) in _GLOBAL_GROUPS.items():
        rows = [quotes[symbol] for symbol, _ in instruments if symbol in quotes]
        unavailable = [symbol for symbol, _ in instruments if symbol in failed]
        waiting = [symbol for symbol, _ in instruments if symbol in timed_out]
        skipped = [symbol for symbol, _ in instruments if symbol in capacity_skipped]
        as_of = max((str(row["asOf"]) for row in rows if row.get("asOf")), default=None)
        status = "delayed" if rows else "missing"
        note = "Yahoo Finance 공개 차트 데이터입니다. 제공 시각은 있는 경우 표시하며 거래소 실시간 시세가 아닐 수 있습니다."
        if unavailable:
            note = f"{note} 가져오지 못한 설정 종목: {', '.join(unavailable)}."
        if waiting:
            note = f"{note} 8초 글로벌 시세 집계 제한으로 기다리지 않은 종목: {', '.join(waiting)}."
        if skipped:
            note = f"{note} 전역 시세 동시 조회 제한으로 시작하지 못한 종목: {', '.join(skipped)}."
        sections.append(
            {
                "id": section_id,
                "title": title,
                "columns": copy.deepcopy(_GLOBAL_COLUMNS_BY_SECTION[section_id]),
                "rows": rows,
                "source": "Yahoo Finance 공개 차트 피드 (지연 가능)",
                "status": status,
                "asOf": as_of,
                "note": note,
                "complete": not unavailable and not waiting and not skipped,
            }
        )
    return sections


def _collect_global_sections() -> list[Section]:
    """Aggregate fixed Yahoo quotes within one wall-clock budget.

    Timed-out futures deliberately continue without cancellation so a task
    which has not started yet can release its reserved global-market slot.
    There can be at most three outstanding tasks, with no executor teardown
    wait on the request path.
    """
    deadline = time.monotonic() + _GLOBAL_DEADLINE_SECONDS
    pending = [instrument for _, instruments in _GLOBAL_GROUPS.values() for instrument in instruments]
    active: dict[Future[tuple[str, dict[str, object] | None]], str] = {}
    quotes: dict[str, dict[str, object]] = {}
    failed: set[str] = set()
    timed_out: set[str] = set()
    capacity_skipped: set[str] = set()

    while pending or active:
        while pending and time.monotonic() < deadline:
            instrument = pending[0]
            future = _submit_global_quote(instrument, deadline)
            if future is None:
                break
            pending.pop(0)
            active[future] = instrument[0]

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out.update(active.values())
            timed_out.update(symbol for symbol, _ in pending)
            break
        if not active:
            capacity_skipped.update(symbol for symbol, _ in pending)
            break

        done, _ = wait(active, timeout=remaining, return_when=FIRST_COMPLETED)
        if not done:
            timed_out.update(active.values())
            timed_out.update(symbol for symbol, _ in pending)
            break
        for future in done:
            symbol = active.pop(future)
            try:
                loaded_symbol, row = future.result()
            except Exception:
                failed.add(symbol)
                continue
            if row is None:
                failed.add(loaded_symbol)
            else:
                quotes[loaded_symbol] = row

    return _global_sections_result(quotes, failed, timed_out, capacity_skipped)


def global_sections(environment: str = "real") -> list[Section]:
    """Return deadline-bounded public global-market sections for screen 0200."""
    selected_environment = _environment(environment)
    if selected_environment != "real":
        return _global_fixture(selected_environment)
    key = ("global",)
    if cached := _cache_get(key):
        return cached  # type: ignore[return-value]
    with _GLOBAL_RUN_LOCK:
        event = _GLOBAL_RUNS.get(key)
        leader = event is None
        if leader:
            event = Event()
            _GLOBAL_RUNS[key] = event
    if not leader:
        assert event is not None
        event.wait(_GLOBAL_DEADLINE_SECONDS)
        if cached := _cache_get(key):
            return cached  # type: ignore[return-value]
        # The leader has not published a cache entry inside this caller's
        # bounded wait.  Every configured quote is therefore explicitly
        # pending rather than falsely reported as a complete empty section.
        pending_symbols = {
            symbol
            for _, instruments in _GLOBAL_GROUPS.values()
            for symbol, _ in instruments
        }
        return _global_sections_result({}, set(), pending_symbols, set())
    try:
        return _cache_put(key, _collect_global_sections(), _GLOBAL_TTL_SECONDS)  # type: ignore[return-value]
    finally:
        with _GLOBAL_RUN_LOCK:
            _GLOBAL_RUNS.pop(key, None)
            assert event is not None
            event.set()
