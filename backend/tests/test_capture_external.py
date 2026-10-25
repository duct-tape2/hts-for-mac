from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock, Thread
import time

import pytest

from app import capture_external as external


RSS = b"""<?xml version='1.0'?><rss><channel>
<item><title>Market &amp; &lt;b&gt;business&lt;/b&gt;</title><link>https://www.bbc.com/news/articles/a</link>
<pubDate>Fri, 23 Oct 2026 16:09:40 GMT</pubDate><description>&lt;p&gt;Short &lt;b&gt;publisher&lt;/b&gt; summary.&lt;/p&gt;</description></item>
</channel></rss>"""

GOOGLE_RSS = b"""<?xml version='1.0'?><rss><channel>
<item><title>Samsung shares move - Example Publisher</title>
<link>https://news.google.com/rss/articles/example-item?oc=5</link>
<pubDate>Fri, 23 Oct 2026 16:09:40 GMT</pubDate>
<description>&lt;p&gt;Search-result summary only.&lt;/p&gt;</description>
<source url="https://example.test">Example Publisher</source></item>
</channel></rss>"""


def _clear_cache() -> None:
    external._CACHE.clear()


def _yahoo(symbol: str = "^GSPC") -> bytes:
    return json.dumps(
        {
            "chart": {
                "result": [
                    {
                        "meta": {
                            "symbol": symbol,
                            "regularMarketPrice": 5000.5,
                            "regularMarketChange": -10.25,
                            "regularMarketChangePercent": -0.2,
                            "regularMarketTime": 1792787900,
                            "currency": "USD",
                            "marketState": "CLOSED",
                        }
                    }
                ]
            }
        }
    ).encode()


def test_fixture_paths_do_not_call_transport(monkeypatch):
    _clear_cache()
    monkeypatch.setattr(external, "_transport", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("network")))
    news = external.news_snapshot(environment="fixture")
    sections = external.global_sections(environment="demo")
    assert news["status"] == "fixture" and news["environment"] == "fixture"
    assert news["news"][0]["provider"] == "테스트 발행사 데이터 (합성)"
    assert len(sections) == 3 and all(section["status"] == "fixture" for section in sections)


def test_publisher_rss_is_labeled_and_uses_direct_allowlisted_links(monkeypatch):
    _clear_cache()
    sent = []

    def transport(url, **_kwargs):
        sent.append(url)
        host = b"www.hankyung.com" if "hankyung" in url else b"www.mk.co.kr"
        return RSS.replace(b"www.bbc.com", host)

    monkeypatch.setattr(external, "_transport", transport)
    payload = external.news_snapshot()
    assert len(sent) == 3 and all(url.startswith("https://") for url in sent)
    assert payload["status"] == "snapshot" and payload["complete"] is True
    assert payload["news"][0]["url"].startswith("https://www.mk.co.kr/")
    assert payload["news"][0]["summary"] == "Short publisher summary."
    assert "발행사" in payload["news"][0]["provider"]


def test_malformed_or_oversized_feeds_are_partial_without_bogus_news(monkeypatch):
    _clear_cache()

    def transport(url, **_kwargs):
        if "50200011" in url:
            return b"not XML"
        if "hankyung" in url:
            return b"x" * (external._RSS_MAX_BYTES + 1)
        return RSS.replace(b"www.bbc.com", b"www.mk.co.kr")

    monkeypatch.setattr(external, "_transport", transport)
    payload = external.news_snapshot()
    assert payload["complete"] is False and payload["status"] == "snapshot"
    assert len(payload["news"]) == 1
    assert "사용할 수 없는 발행사 피드: mk_stock, hankyung_finance." in payload["note"]


def test_invalid_input_and_disallowed_url_do_not_send_transport(monkeypatch):
    _clear_cache()
    sent = []
    monkeypatch.setattr(external, "_transport", lambda url, **_kwargs: sent.append(url) or RSS)
    with pytest.raises(ValueError):
        external.news_snapshot(query="x" * 101)
    with pytest.raises(ValueError):
        external.news_snapshot(provider="https://127.0.0.1/")
    with pytest.raises(ValueError):
        external.news_snapshot(provider="google")
    with pytest.raises(ValueError):
        external._fetch_bytes("http://127.0.0.1/private", max_bytes=32)
    assert external._safe_original_url("https://www.bbc.com:invalid/article", {"www.bbc.com"}) == ""
    assert sent == []


def test_query_without_a_publisher_match_clears_news_instead_of_returning_all(monkeypatch):
    _clear_cache()
    monkeypatch.setattr(external, "_transport", lambda url, **_kwargs: RSS.replace(b"www.bbc.com", b"www.mk.co.kr"))
    payload = external.news_snapshot(query="not-present-in-fixture")
    assert payload["status"] == "missing" and payload["news"] == [] and payload["rows"] == []


def test_google_search_is_query_bound_aggregator_and_cache_keys_are_distinct(monkeypatch):
    _clear_cache()
    calls = []

    def transport(url, **_kwargs):
        calls.append(url)
        return GOOGLE_RSS

    monkeypatch.setattr(external, "_transport", transport)
    first = external.news_snapshot(query="삼성전자", provider="google")
    second = external.news_snapshot(query="빅텍", provider="google")
    assert len(calls) == 2 and all(url.startswith("https://news.google.com/rss/search?") for url in calls)
    assert "q=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90" in calls[0] and "q=%EB%B9%85%ED%85%8D" in calls[1]
    assert first["news"][0]["url"].startswith("https://news.google.com/")
    assert "집계" in first["news"][0]["provider"]
    assert "Google News 결과는 검색 집계" in second["note"]
    assert "로컬 필터" not in second["note"]


def test_all_with_query_adds_google_search_but_default_all_does_not(monkeypatch):
    _clear_cache()
    calls = []

    def transport(url, **_kwargs):
        calls.append(url)
        if "news.google.com" in url:
            return GOOGLE_RSS
        return RSS.replace(b"www.bbc.com", b"www.mk.co.kr")

    monkeypatch.setattr(external, "_transport", transport)
    external.news_snapshot()
    _clear_cache()
    queried = external.news_snapshot(query="삼성전자")
    assert len(calls) == 7 and any("news.google.com/rss/search" in url for url in calls[3:])
    assert any("Google News RSS 검색" in article["provider"] for article in queried["news"])


def test_global_sections_parse_finite_quotes_and_mark_them_delayed(monkeypatch):
    _clear_cache()
    calls = []

    def transport(url, **_kwargs):
        calls.append(url)
        return _yahoo()

    monkeypatch.setattr(external, "_transport", transport)
    sections = external.global_sections()
    assert len(calls) == 9 and len(sections) == 3
    assert all(section["status"] == "delayed" and section["complete"] is True for section in sections)
    first = sections[0]["rows"][0]
    assert first["last"] == 5000.5 and first["change"] == -10.25
    assert first["asOf"].endswith("Z") and first["timing"] == "possibly delayed"
    assert "거래소 실시간 시세가 아닐 수 있습니다" in sections[0]["note"]


def test_global_sections_publish_quote_precision_by_group(monkeypatch):
    _clear_cache()
    monkeypatch.setattr(external, "_transport", lambda *_args, **_kwargs: _yahoo())
    sections = {section["id"]: section for section in external.global_sections()}
    precision = lambda section_id, key: next(column["precision"] for column in sections[section_id]["columns"] if column["key"] == key)
    assert precision("global-indices", "last") == 2
    assert precision("global-commodities", "change") == 2
    assert precision("global-fx", "last") == 4
    assert precision("global-fx", "change") == 4
    assert precision("global-fx", "changePct") == 2


def test_rss_date_preserves_explicit_korean_offsets_and_localizes_external_labels():
    assert external._rss_date("Sat, 24 Oct 2026 17:06:17 +09:00") == "2026-10-24T08:06:17Z"
    assert external._rss_date("Sat, 24 Oct 2026 17:06:17 +0900") == "2026-10-24T08:06:17Z"
    assert external._rss_date("Sat, 24 Oct 2026 17:06:17 KST") == "2026-10-24T08:06:17Z"
    assert external._rss_date("Sat, 24 Oct 2026 08:06:17 +0000") == "2026-10-24T08:06:17Z"
    assert external._GLOBAL_GROUPS["global-indices"][0] == "글로벌 주요 지수"
    assert external._GLOBAL_COLUMNS[0]["label"] == "종목"


def test_bad_quote_payload_produces_missing_section_not_synthetic_values(monkeypatch):
    _clear_cache()
    monkeypatch.setattr(external, "_transport", lambda *_args, **_kwargs: b'{"chart":{"result":[]}}')
    sections = external.global_sections()
    assert all(section["status"] == "missing" and section["rows"] == [] and section["complete"] is False for section in sections)


def test_global_sections_deadline_keeps_completed_quote_rows(monkeypatch):
    _clear_cache()
    entered, release, transport_finished = Event(), Event(), Event()

    def transport(url, **_kwargs):
        if "GSPC" in url:
            entered.set()
            try:
                assert release.wait(1)
            finally:
                transport_finished.set()
        return _yahoo()

    monkeypatch.setattr(external, "_transport", transport)
    monkeypatch.setattr(external, "_GLOBAL_DEADLINE_SECONDS", 0.05)
    monkeypatch.setattr(external, "_GLOBAL_PROVIDER_TIMEOUT_SECONDS", 1.0)
    started = time.monotonic()
    try:
        sections = external.global_sections()
        elapsed = time.monotonic() - started
        indices = next(section for section in sections if section["id"] == "global-indices")
        assert entered.is_set() and elapsed < 0.2
        assert len(indices["rows"]) == 3 and indices["complete"] is False
        assert "8초 글로벌 시세 집계 제한" in indices["note"]
        assert sum(len(section["rows"]) for section in sections) == 8
    finally:
        release.set()
    assert transport_finished.wait(1)


def test_global_sections_follower_timeout_marks_empty_sections_incomplete(monkeypatch):
    _clear_cache()
    entered, release = Event(), Event()
    leader_result: list[list[dict[str, object]]] = []

    def transport(url, **_kwargs):
        if "GSPC" in url:
            entered.set()
            assert release.wait(1)
        return _yahoo()

    monkeypatch.setattr(external, "_transport", transport)
    monkeypatch.setattr(external, "_GLOBAL_DEADLINE_SECONDS", 0.2)
    leader = Thread(target=lambda: leader_result.append(external.global_sections()))
    leader.start()
    try:
        assert entered.wait(1)
        # The leader captured the longer deadline already.  A second caller
        # must use its own shorter wait budget and receive explicit pending
        # sections instead of falsely complete empty ones.
        monkeypatch.setattr(external, "_GLOBAL_DEADLINE_SECONDS", 0.05)
        follower = external.global_sections()
        assert all(section["rows"] == [] and section["complete"] is False for section in follower)
        assert all("8초 글로벌 시세 집계 제한" in section["note"] for section in follower)
    finally:
        release.set()
        leader.join(1)
    assert not leader.is_alive() and leader_result


def test_news_workers_are_globally_capped_without_queuing_excess_requests(monkeypatch):
    _clear_cache()
    release, three_started = Event(), Event()
    state_lock = Lock()
    state = {"active": 0, "peak": 0, "calls": 0}

    def transport(url, **_kwargs):
        with state_lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
            state["calls"] += 1
            if state["active"] == 3:
                three_started.set()
        try:
            assert release.wait(1)
        finally:
            with state_lock:
                state["active"] -= 1
        host = b"www.bbc.com" if "bbc" in url else b"www.npr.org" if "npr" in url else b"en.yna.co.kr"
        return RSS.replace(b"www.bbc.com", host)

    monkeypatch.setattr(external, "_transport", transport)
    results: dict[str, dict[str, object]] = {}
    threads = [
        Thread(target=lambda name=name: results.setdefault(name, external.news_snapshot(provider=name)))
        for name in ("bbc", "npr", "yonhap")
    ]
    for thread in threads:
        thread.start()
    try:
        assert three_started.wait(1)
        skipped = external.news_snapshot(provider="mk_stock")
        assert skipped["complete"] is False
        assert "전역 동시 조회 제한" in skipped["note"]
        with state_lock:
            assert state == {"active": 3, "peak": 3, "calls": 3}
    finally:
        release.set()
        for thread in threads:
            thread.join(1)
    assert all(not thread.is_alive() for thread in threads)
    assert all(result["status"] == "snapshot" for result in results.values())


def test_news_deadline_returns_without_waiting_for_stuck_worker(monkeypatch):
    _clear_cache()
    entered, release, transport_finished = Event(), Event(), Event()

    def transport(url, **_kwargs):
        if "50200011" in url:
            entered.set()
            try:
                assert release.wait(1)
            finally:
                transport_finished.set()
        host = b"www.hankyung.com" if "hankyung" in url else b"www.mk.co.kr"
        return RSS.replace(b"www.bbc.com", host)

    monkeypatch.setattr(external, "_transport", transport)
    monkeypatch.setattr(external, "_NEWS_DEADLINE_SECONDS", 0.05)
    monkeypatch.setattr(external, "_NEWS_PROVIDER_TIMEOUT_SECONDS", 1.0)
    started = time.monotonic()
    try:
        payload = external.news_snapshot()
        elapsed = time.monotonic() - started
        assert entered.is_set()
        assert elapsed < 0.2
        assert payload["status"] == "snapshot" and payload["news"]
        assert payload["complete"] is False
        assert "10초 뉴스 집계 제한" in payload["note"]
    finally:
        release.set()
    assert transport_finished.wait(1)


def test_deadline_does_not_cancel_queued_work_and_leak_worker_slots(monkeypatch):
    _clear_cache()
    entered, release = Event(), Event()
    calls = 0
    calls_lock = Lock()
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="test-public-news")

    def transport(url, **_kwargs):
        nonlocal calls
        with calls_lock:
            calls += 1
            first = calls == 1
        if first:
            entered.set()
            assert release.wait(1)
        host = b"www.hankyung.com" if "hankyung" in url else b"www.mk.co.kr"
        return RSS.replace(b"www.bbc.com", host)

    monkeypatch.setattr(external, "_NEWS_POOL", pool)
    monkeypatch.setattr(external, "_transport", transport)
    monkeypatch.setattr(external, "_NEWS_DEADLINE_SECONDS", 0.05)
    try:
        payload = external.news_snapshot()
        assert entered.is_set() and "10초 뉴스 집계 제한" in payload["note"]
    finally:
        release.set()
        pool.shutdown(wait=True)

    acquired = 0
    try:
        while acquired < 3:
            assert external._NEWS_WORKER_SLOTS.acquire(blocking=False)
            acquired += 1
    finally:
        for _ in range(acquired):
            external._NEWS_WORKER_SLOTS.release()
    assert calls == 3
