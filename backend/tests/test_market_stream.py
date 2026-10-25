from __future__ import annotations

import asyncio
import builtins
import importlib
import queue
import sys
import threading
import time
import traceback
from typing import Any

import pytest

from app import condition_search
from app import market_stream


class Gateway:
    ENVIRONMENT = "real"

    def __init__(self) -> None:
        self.allowed: list[str] = []

    def assert_realtime_allowed(self, *, market: str) -> None:
        self.allowed.append(market)

    def websocket_auth_snapshot(self) -> tuple[str, int]:
        return "synthetic-token", 0

    async def open_realtime(self, *_args: Any, **_kwargs: Any) -> None:  # pragma: no cover - factory is only assigned
        raise AssertionError("fake SDK client must not open a network socket")


class FakeClient:
    def __init__(self) -> None:
        self.created_at = time.monotonic()
        self.connected_at: float | None = None
        self.connected = False
        self.connects: list[str] = []
        self.sent: list[dict[str, Any]] = []
        self.incoming: queue.Queue[Any] = queue.Queue()
        self._connect_factory: Any = None

    @property
    def is_connected(self) -> bool:
        return self.connected

    async def connect(self, *, api_url: str) -> None:
        self.connected = True
        self.connected_at = time.monotonic()
        self.connects.append(api_url)

    async def send(self, packet: dict[str, Any]) -> None:
        self.sent.append(packet)

    async def recv(self) -> Any:
        while True:
            try:
                return self.incoming.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.005)

    async def close(self) -> None:
        self.connected = False


def _identity(market: str, code: str, *, venue: str | None = None) -> dict[str, str]:
    if market == "KR":
        return {"environment": "real", "market": "KR", "stkCd": code, "listingVenue": "KOSPI", "quoteVenue": "KRX", "stexTp": "KRX"}
    exchange = venue or "ND"
    return {"environment": "real", "market": "US", "stkCd": code, "listingVenue": {"ND": "NASDAQ", "NY": "NYSE", "NA": "AMEX"}[exchange], "quoteVenue": exchange, "stexTp": exchange}


@pytest.fixture(autouse=True)
def registry(monkeypatch):
    market_stream.stop()
    module = importlib.reload(market_stream)
    gateway = Gateway()
    clients: list[FakeClient] = []

    def client_factory(*_tokens: Any) -> FakeClient:
        client = FakeClient()
        clients.append(client)
        return client

    monkeypatch.setattr(module, "gateway", gateway)
    monkeypatch.setattr(module, "_sdk_get_ws_client", client_factory)
    yield module, gateway, clients
    module.stop()


def _wait_until(predicate, timeout: float = 1.5) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition did not become true")


def _registration(client: FakeClient, event_type: str) -> list[dict[str, Any]]:
    return [packet for packet in client.sent if packet.get("trnm") == "REG" and event_type in packet["data"][0]["type"]]


def _wait_for_registration(stream, clients: list[FakeClient], event_type: str, *, started_at: float) -> FakeClient:
    """Keep cold-start registration failures actionable without exposing payloads."""
    try:
        _wait_until(lambda: len(clients) == 1 and len(_registration(clients[0], event_type)) == 1)
    except AssertionError as exc:
        summaries = [
            {
                "connected": client.connected,
                "connectPaths": list(client.connects),
                "createdAfterSeconds": round(client.created_at - started_at, 3),
                "connectedAfterSeconds": None if client.connected_at is None else round(client.connected_at - started_at, 3),
                "packets": [
                    {
                        "trnm": packet.get("trnm"),
                        "types": list(packet.get("data", [{}])[0].get("type", [])) if isinstance(packet.get("data"), list) and packet["data"] else [],
                    }
                    for packet in client.sent
                ],
            }
            for client in clients
        ]
        worker = getattr(stream, "_thread", None)
        frame = sys._current_frames().get(worker.ident) if isinstance(worker, threading.Thread) and worker.ident is not None else None
        worker_stack = traceback.format_stack(frame, limit=20) if frame is not None else []
        raise AssertionError(
            f"{event_type} registration was not ready after {time.monotonic() - started_at:.3f}s; "
            f"clients={summaries}; stream={stream.status()}; workerStack={worker_stack}"
        ) from exc
    return clients[0]


def _direct_instrument(stream, identity: dict[str, str]) -> tuple[str, ...]:
    canonical = stream._canonical_identity(identity)
    key = stream._identity_key(canonical)
    with stream._lock:
        stream._instruments[key] = stream._Instrument(identity=canonical, snapshot=stream._initial_snapshot(canonical))
    return key


def _thread_call(callback):
    outcome: dict[str, Any] = {}

    def run() -> None:
        try:
            outcome["result"] = callback()
        except Exception as exc:  # tests assert the safe public error below
            outcome["error"] = exc

    thread = threading.Thread(target=run)
    thread.start()
    return thread, outcome


def _enable_live_conditions(gateway: Gateway, monkeypatch) -> None:
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True, raising=False)


def test_idle_start_does_not_leave_a_lifecycle_worker(registry):
    stream, _gateway, clients = registry
    stream.start()
    time.sleep(0.05)
    assert clients == []
    assert stream._thread is None


def test_preloaded_packet_builders_do_not_import_on_worker_registration(registry, monkeypatch):
    """A cold pandas/SDK import must finish before the worker's readiness path."""
    stream, _gateway, clients = registry
    assert callable(stream._sdk_build_reg_packet)
    assert callable(stream._sdk_build_remove_packet)
    imports: list[str] = []
    original_import = builtins.__import__

    def observe_import(name, *args, **kwargs):
        if name == "kiwoom.realtime":
            imports.append(name)
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", observe_import)
    started_at = time.monotonic()
    stream.subscribe(_identity("US", "NVDA"))
    _wait_for_registration(stream, clients, "FE", started_at=started_at)
    assert imports == []


def test_shared_subscription_refcounts_and_release_last_viewer(registry):
    stream, gateway, clients = registry
    identity = _identity("US", "NVDA")
    started_at = time.monotonic()
    first, second = stream.subscribe(identity), stream.subscribe(identity)
    client = _wait_for_registration(stream, clients, "FE", started_at=started_at)
    assert stream.status()["activeSubscribers"] == 2
    assert len(_registration(client, "FT")) == 1
    assert stream.unsubscribe(first) is True
    time.sleep(0.08)
    assert not [packet for packet in client.sent if packet.get("trnm") == "REMOVE"]
    assert stream.unsubscribe(second) is True
    _wait_until(lambda: any(packet.get("trnm") == "REMOVE" for packet in client.sent))
    remove = next(packet for packet in client.sent if packet.get("trnm") == "REMOVE")
    assert remove["data"][0]["item"] == [{"jmcode": "NVDA", "stex_tp": "ND"}]
    assert stream.status()["activeInstruments"] == 0
    assert gateway.allowed == ["US"]


def test_distinct_full_identities_are_isolated_not_same_code_only(registry):
    stream, _gateway, clients = registry
    nd = _identity("US", "TEST", venue="ND")
    ny = _identity("US", "TEST", venue="NY")
    started_at = time.monotonic()
    stream.subscribe(nd)
    stream.subscribe(ny)
    client = _wait_for_registration(stream, clients, "FE", started_at=started_at)
    client.incoming.put({"trnm": "REAL", "data": [{"type": "FE", "item": "TEST", "stexTp": "ND", "values": {"10": "+100.25", "11": "+1", "12": "+1.0", "13": "0"}}]})
    _wait_until(lambda: stream.snapshot(nd)["status"] == "live")
    assert stream.snapshot(nd)["last"] == 100.25
    assert stream.snapshot(nd)["volume"] == 0.0
    assert stream.snapshot(ny)["status"] == "pending"


def test_kr_0b_and_0d_map_trade_and_ten_level_book(registry):
    stream, gateway, clients = registry
    identity = _identity("KR", "A12345")
    stream.subscribe(identity)
    _wait_until(lambda: len(clients) == 1 and _registration(clients[0], "0B"))
    client = clients[0]
    client.incoming.put({"trnm": "REAL", "data": [{"type": "0B", "item": "A12345", "values": {"10": "-71500", "11": "-500", "12": "-0.70", "13": "0", "20": "153000"}}]})
    _wait_until(lambda: stream.snapshot(identity).get("last") == 71500.0)
    client.incoming.put({"trnm": "REAL", "data": [{"type": "0D", "item": "A12345", "values": {"41": "-71510", "61": "0", "51": "+71490", "71": "3", "50": "+71480", "70": "4"}}]})
    _wait_until(lambda: stream.snapshot(identity).get("bookLive") is True)
    snapshot = stream.snapshot(identity)
    assert snapshot["change"] == -500.0 and snapshot["changePct"] == -0.70
    assert snapshot["volume"] == 0.0
    assert snapshot["asks"] == [{"price": 71480.0, "qty": 4.0}, {"price": 71510.0, "qty": 0.0}]
    assert snapshot["bids"] == [{"price": 71490.0, "qty": 3.0}]
    assert snapshot["sourceTimestamp"] is None
    assert gateway.allowed == ["KR"]


def test_us_fe_and_ft_map_without_synthetic_last_or_midpoint(registry):
    stream, _gateway, clients = registry
    identity = _identity("US", "NVDA")
    stream.subscribe(identity)
    _wait_until(lambda: len(clients) == 1 and _registration(clients[0], "FT"))
    client = clients[0]
    client.incoming.put({"trnm": "REAL", "data": [{"type": "FE", "item": "NVDA", "stexTp": "ND", "values": {"10": "+198.5000", "11": "+3.5300", "12": "+1.81", "13": "0", "22": "20260630", "51020": "215300"}}]})
    _wait_until(lambda: stream.snapshot(identity).get("last") == 198.5)
    client.incoming.put({"trnm": "REAL", "data": [{"type": "FT", "item": "NVDA", "stexTp": "ND", "values": {"41": "+198.54", "61": "0", "51": "+198.48", "71": "9"}}]})
    _wait_until(lambda: stream.snapshot(identity).get("bookLive") is True)
    snapshot = stream.snapshot(identity)
    assert snapshot["last"] == 198.5
    assert snapshot["asks"] == [{"price": 198.54, "qty": 0.0}]
    assert snapshot["bids"] == [{"price": 198.48, "qty": 9.0}]
    assert "midPrice" not in snapshot and snapshot["sourceTimestamp"] is None


def test_reconnect_resubscribes_only_active_identities_and_marks_stale(registry):
    stream, _gateway, clients = registry
    first, second = _identity("KR", "A12345"), _identity("KR", "B12345")
    first_id = stream.subscribe(first)
    second_id = stream.subscribe(second)
    _wait_until(lambda: len(clients) == 1 and _registration(clients[0], "0B"))
    clients[0].incoming.put({"trnm": "REAL", "data": [{"type": "0B", "item": "A12345", "values": {"10": "+100"}}]})
    _wait_until(lambda: stream.snapshot(first).get("last") == 100.0)
    assert stream.event_journal(first)["latestSequence"] == 1
    assert stream.unsubscribe(second_id)
    clients[0].connected = False
    _wait_until(lambda: len(clients) == 2 and _registration(clients[1], "0B"))
    packet = _registration(clients[1], "0B")[0]
    assert packet["data"][0]["item"] == ["A12345"]
    clients[1].incoming.put({"trnm": "REAL", "data": [{"type": "0B", "item": "A12345", "values": {"10": "+101"}}]})
    _wait_until(lambda: stream.event_journal(first)["latestSequence"] == 2)
    tape = stream.event_journal(first)
    assert tape["transportGap"]["afterSequence"] == 1
    assert tape["events"][-1]["gapBefore"]["afterSequence"] == 1
    assert stream.snapshot(first)["status"] in {"live", "stale"}
    assert stream.unsubscribe(first_id)
    assert stream.event_journal(first) is None


def test_auth_generation_reconnect_preserves_subscriber_refs_and_registrations(registry):
    stream, _gateway, clients = registry
    identity = _identity("US", "NVDA")
    first, second = stream.subscribe(identity), stream.subscribe(identity)
    _wait_until(lambda: len(clients) == 1 and _registration(clients[0], "FE"))
    stream.auth_generation_changed(1)
    _wait_until(lambda: len(clients) == 2 and _registration(clients[1], "FE"))
    assert stream.status()["activeSubscribers"] == 2
    assert stream.status()["activeInstruments"] == 1
    assert stream.unsubscribe(first) and stream.unsubscribe(second)


def test_rotation_during_connect_keeps_actual_login_generation_stale(registry, monkeypatch):
    stream, gateway, _clients = registry
    started, release = threading.Event(), threading.Event()

    class BlockingClient(FakeClient):
        async def connect(self, *, api_url: str) -> None:
            started.set()
            await asyncio.to_thread(release.wait)
            self.connected = True
            self.connects.append(api_url)

    client = BlockingClient()
    monkeypatch.setattr(gateway, "KIWOOM_ENABLED", True, raising=False)
    monkeypatch.setattr(gateway, "websocket_auth_snapshot", lambda: ("synthetic-token", 0), raising=False)
    monkeypatch.setattr(stream, "_sdk_get_ws_client", lambda _token: client)

    async def exercise():
        session = stream._Session("KR")
        task = asyncio.create_task(stream._ensure_connected(session))
        assert await asyncio.to_thread(started.wait, 1)
        stream.auth_generation_changed(1)
        release.set()
        await task
        return session.auth_generation

    assert asyncio.run(exercise()) == 0


def test_failed_connect_closes_unowned_sdk_client(registry, monkeypatch):
    stream, _gateway, _clients = registry

    class FailingClient(FakeClient):
        closed = False

        async def connect(self, *, api_url: str) -> None:
            self.connected = True  # model an SDK socket opened before LOGIN fails
            raise RuntimeError("synthetic login failure")

        async def close(self) -> None:
            self.closed = True
            self.connected = False

    client = FailingClient()
    monkeypatch.setattr(stream, "_sdk_get_ws_client", lambda: client)

    async def exercise():
        with pytest.raises(RuntimeError):
            await stream._ensure_connected(stream._Session("KR"))

    asyncio.run(exercise())
    assert client.closed is True


def test_registration_rejection_is_explicit_and_ack_is_not_live(registry):
    stream, _gateway, clients = registry
    identity = _identity("KR", "A12345")
    stream.subscribe(identity)
    _wait_until(lambda: clients and _registration(clients[0], "0D"))
    assert stream.snapshot(identity)["status"] == "pending"
    clients[0].incoming.put({"trnm": "REG", "return_code": "1", "return_msg": "never exposed"})
    _wait_until(lambda: stream.snapshot(identity)["status"] == "subscription-error")
    assert stream.status()["markets"]["KR"]["error"] == "Broker rejected registration."


def test_freshness_expires_without_inventing_new_data(registry):
    stream, _gateway, clients = registry
    identity = _identity("KR", "A12345")
    stream.subscribe(identity)
    _wait_until(lambda: clients and _registration(clients[0], "0B"))
    clients[0].incoming.put({"trnm": "REAL", "data": [{"type": "0B", "item": "A12345", "values": {"10": "+100"}}]})
    _wait_until(lambda: stream.snapshot(identity).get("last") == 100.0)
    with stream._lock:
        stored = next(iter(stream._instruments.values())).snapshot
        stored["_tradeMonotonic"] = time.monotonic() - stream.FRESH_SECONDS - 1.0
        stored["_bookMonotonic"] = 0.0
    snapshot = stream.snapshot(identity)
    assert snapshot["status"] == "stale"
    assert snapshot["bookLive"] is False
    assert snapshot["last"] == 100.0


def test_reconnect_uses_capped_exponential_backoff_with_fake_clock(registry, monkeypatch):
    stream, _gateway, _clients = registry
    clock = {"now": 0.0}
    attempts: list[float] = []
    settled: list[float] = []

    class FailingClient:
        _connect_factory: Any = None

        @property
        def is_connected(self) -> bool:
            return False

        async def connect(self, *, api_url: str) -> None:
            attempts.append(clock["now"])
            raise RuntimeError("transport unavailable")

    monkeypatch.setattr(stream, "_monotonic", lambda: clock["now"])
    monkeypatch.setattr(stream, "_sdk_get_ws_client", FailingClient)
    original_session_failed = stream._session_failed

    async def observed_session_failed(session, message):
        await original_session_failed(session, message)
        settled.append(session.next_retry_at)

    monkeypatch.setattr(stream, "_session_failed", observed_session_failed)
    stream.subscribe(_identity("KR", "A12345"))
    _wait_until(lambda: attempts == [0.0])
    _wait_until(lambda: settled == [1.0])
    time.sleep(0.1)
    assert attempts == [0.0]  # no 20 ms reconnect storm
    for count, retry_at in enumerate((1.0, 3.0, 7.0, 15.0, 31.0, 61.0), start=2):
        clock["now"] = retry_at
        _wait_until(lambda: len(attempts) >= count)
        assert attempts[-1] == retry_at
        _wait_until(lambda: len(settled) >= count)
    assert attempts == [0.0, 1.0, 3.0, 7.0, 15.0, 31.0, 61.0]
    # The post-31 interval is 30 seconds, proving the retry ceiling is active.
    assert stream.RETRY_MAX_SECONDS == 30.0


def test_stop_cancels_blocked_connect_before_a_new_worker_can_start(registry, monkeypatch):
    stream, _gateway, clients = registry
    started, cancelled = threading.Event(), threading.Event()

    class BlockingClient:
        _connect_factory: Any = None

        @property
        def is_connected(self) -> bool:
            return False

        async def connect(self, *, api_url: str) -> None:
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

    def factory() -> BlockingClient:
        client = BlockingClient()
        clients.append(client)  # type: ignore[arg-type]
        return client

    monkeypatch.setattr(stream, "_sdk_get_ws_client", factory)
    stream.subscribe(_identity("KR", "A12345"))
    assert started.wait(timeout=1.0)
    stream.stop()
    assert cancelled.is_set()
    assert stream.status()["activeInstruments"] == 0
    stream.start()
    time.sleep(0.08)
    assert len(clients) == 1


def test_malformed_empty_real_frames_do_not_claim_live(registry):
    stream, _gateway, clients = registry
    identity = _identity("KR", "A12345")
    stream.subscribe(identity)
    _wait_until(lambda: clients and _registration(clients[0], "0B"))
    clients[0].incoming.put({"trnm": "REAL", "data": [{"type": "0B", "item": "A12345", "values": {}}]})
    clients[0].incoming.put({"trnm": "REAL", "data": [{"type": "0D", "item": "A12345", "values": {"41": "", "61": "0"}}]})
    time.sleep(0.12)
    snapshot = stream.snapshot(identity)
    assert snapshot["status"] == "pending"
    assert snapshot["tradeReceivedAt"] is None and snapshot["bookReceivedAt"] is None


def test_blocked_kr_connect_cannot_pause_healthy_us_realtime(registry, monkeypatch):
    stream, _gateway, clients = registry
    kr_connect_started = threading.Event()

    class BlockingKrClient:
        _connect_factory: Any = None

        @property
        def is_connected(self) -> bool:
            return False

        async def connect(self, *, api_url: str) -> None:
            assert api_url == "/api/dostk/websocket"
            kr_connect_started.set()
            await asyncio.Event().wait()

    blocked, healthy = BlockingKrClient(), FakeClient()
    factory_results = iter((blocked, healthy))

    def factory() -> Any:
        client = next(factory_results)
        clients.append(client)  # type: ignore[arg-type]
        return client

    monkeypatch.setattr(stream, "_sdk_get_ws_client", factory)
    kr = _identity("KR", "A12345")
    us = _identity("US", "NVDA")
    stream.subscribe(kr)
    stream.subscribe(us)
    assert kr_connect_started.wait(timeout=0.3)
    _wait_until(lambda: _registration(healthy, "FE"), timeout=0.3)
    began = time.monotonic()
    healthy.incoming.put({"trnm": "REAL", "data": [{"type": "FE", "item": "NVDA", "stexTp": "ND", "values": {"10": "+198.50"}}]})
    _wait_until(lambda: stream.snapshot(us).get("last") == 198.5, timeout=0.3)
    assert time.monotonic() - began < 0.3


def test_volume_only_event_keeps_price_freshness_and_retains_raw_kr_time(registry):
    stream, _gateway, _clients = registry
    identity = _identity("KR", "A12345")
    key = _direct_instrument(stream, identity)

    assert stream._apply_trade(key, {"type": "0B", "last": "+100", "volume": "10", "tradeTime": "153000"})
    priced = stream.snapshot(identity)
    assert priced["sourceTimestamp"] is None
    assert priced["tradeSourceTime"] == {
        "rawTradeTime": "153000", "rawTradeDate": None, "rawLocalTradeTime": None,
        "precision": "second", "datePrecision": "unavailable", "timezone": "unverified",
        "timestamp": None, "timestampStatus": "not-derived: provider calendar/timezone relationship is unverified",
    }
    price_at = priced["priceReceivedAt"]

    assert stream._apply_trade(key, {"type": "0B", "volume": "11", "tradeTime": "153001"})
    updated = stream.snapshot(identity)
    assert updated["last"] == 100.0
    assert updated["priceReceivedAt"] == price_at == updated["tradeReceivedAt"]
    assert updated["volumeReceivedAt"] is not None
    assert updated["tradeSourceTime"]["rawTradeTime"] == "153001"
    assert stream.event_journal(identity)["events"][-1]["last"] is None


def test_us_raw_time_is_retained_without_synthesizing_a_source_timestamp(registry):
    stream, _gateway, _clients = registry
    identity = _identity("US", "NVDA")
    key = _direct_instrument(stream, identity)

    assert stream._apply_trade(key, {"type": "FE", "last": "+198.50", "tradeTime": "215300", "tradeDate": "20260630", "localTradeTime": "215300"})
    snapshot = stream.snapshot(identity)
    assert snapshot["sourceTimestamp"] is None
    assert snapshot["tradeSourceTime"]["rawTradeDate"] == "20260630"
    assert snapshot["tradeSourceTime"]["rawLocalTradeTime"] == "215300"
    assert snapshot["tradeSourceTime"]["timezone"] == "unverified"
    assert snapshot["tradeSourceTime"]["timestamp"] is None


def test_book_event_has_own_raw_time_and_does_not_refresh_trade_time(registry):
    stream, _gateway, _clients = registry
    identity = _identity("KR", "A12345")
    key = _direct_instrument(stream, identity)
    stream._apply_trade(key, {"type": "0B", "last": "+100", "tradeTime": "153000"})
    trade = stream.snapshot(identity)

    assert stream._apply_book(key, {"type": "0D", "ask1": "+101", "ask1qty": "2", "tradeTime": "153001"})
    snapshot = stream.snapshot(identity)
    assert snapshot["tradeReceivedAt"] == trade["tradeReceivedAt"]
    assert snapshot["tradeSourceTime"] == trade["tradeSourceTime"]
    assert snapshot["bookReceivedAt"] is not None
    assert snapshot["bookSourceTime"]["rawTradeTime"] == "153001"
    assert snapshot["sourceTimestamp"] is None


def test_transport_stale_state_disables_all_field_live_flags(registry):
    stream, _gateway, _clients = registry
    identity = _identity("KR", "A12345")
    key = _direct_instrument(stream, identity)
    stream._apply_trade(key, {"type": "0B", "last": "+100", "volume": "10"})
    stream._mark_market_stale("KR", "synthetic reconnect")

    snapshot = stream.snapshot(identity)
    assert snapshot["status"] == "stale"
    assert snapshot["priceLive"] is False
    assert snapshot["volumeLive"] is False
    assert snapshot["bookLive"] is False


def test_arrival_journal_retains_same_second_events_and_observed_aggregates(registry, monkeypatch):
    stream, _gateway, _clients = registry
    identity = _identity("KR", "A12345")
    key = _direct_instrument(stream, identity)
    received = iter(("2026-10-25T00:01:02Z", "2026-10-25T00:01:40Z", "2026-10-25T00:02:00Z"))
    monkeypatch.setattr(stream, "_utc_now", lambda: next(received))

    stream._apply_trade(key, {"type": "0B", "last": "+100", "tradeTime": "153000"})
    stream._apply_trade(key, {"type": "0B", "last": "+101", "tradeTime": "153000"})
    tape = stream.event_journal(identity)
    assert [(event["sequence"], event["last"], event["eventType"]) for event in tape["events"]] == [(1, 100.0, "0B"), (2, 101.0, "0B")]
    metadata = stream.event_metadata(identity)
    observed = metadata["observedOhlc"]
    assert (observed["open"], observed["high"], observed["low"], observed["close"], observed["count"]) == (100.0, 101.0, 100.0, 101.0, 2)
    assert observed["sourceTimestamp"] is None and observed["complete"] is False
    minute = metadata["observedMinute"]
    assert (minute["basis"], minute["bucketStart"], minute["open"], minute["close"], minute["count"], minute["firstSequence"], minute["lastSequence"]) == ("receipt-time observations", "2026-10-25T00:01:00Z", 100.0, 101.0, 2, 1, 2)

    stream._apply_trade(key, {"type": "0B", "last": "+99", "tradeTime": "153001"})
    minute = stream.event_metadata(identity)["observedMinute"]
    assert (minute["bucketStart"], minute["open"], minute["high"], minute["low"], minute["close"], minute["count"], minute["firstSequence"], minute["lastSequence"]) == ("2026-10-25T00:02:00Z", 99.0, 99.0, 99.0, 99.0, 1, 3, 3)


def test_event_journal_is_bounded_and_reports_evicted_cursor_gap(registry):
    stream, _gateway, _clients = registry
    identity = _identity("KR", "A12345")
    key = _direct_instrument(stream, identity)
    for offset in range(stream.EVENT_JOURNAL_LIMIT + 2):
        stream._apply_trade(key, {"type": "0B", "last": str(100 + offset), "tradeTime": "153000"})

    tape = stream.event_journal(identity, after_sequence=0)
    assert len(tape["events"]) == stream.EVENT_JOURNAL_LIMIT
    assert tape["oldestSequence"] == 3 and tape["latestSequence"] == stream.EVENT_JOURNAL_LIMIT + 2
    assert tape["gap"] is True
    assert tape["sequenceSemantics"] == "local process arrival order; not provider or exchange order"


def test_event_type_routing_preserves_case(registry):
    stream, _gateway, _clients = registry
    identity = _identity("KR", "A12345")
    _direct_instrument(stream, identity)
    session = stream._Session("KR")

    stream._handle_event(session, {"trnm": "REAL", "type": "0b", "item": "A12345", "last": "+100"})
    assert stream.event_journal(identity)["events"] == []
    stream._handle_event(session, {"trnm": "REAL", "type": "0B", "item": "A12345", "last": "+100"})
    assert stream.event_journal(identity)["events"][0]["eventType"] == "0B"


def test_condition_list_uses_the_market_worker_without_quote_subscriptions(registry, monkeypatch):
    stream, gateway, clients = registry
    _enable_live_conditions(gateway, monkeypatch)
    thread, outcome = _thread_call(lambda: stream.condition_list("KR", timeout_seconds=0.5))
    _wait_until(lambda: clients and any(packet.get("trnm") == "CNSRLST" for packet in clients[0].sent))
    assert not [packet for packet in clients[0].sent if packet.get("trnm") == "REG"]
    clients[0].incoming.put({"trnm": "CNSRLST", "return_code": 0, "data": [["4", "실전 조건"]]})
    thread.join(timeout=1.0)
    assert not thread.is_alive() and "error" not in outcome
    assert outcome["result"]["conditions"] == [{"seq": "4", "name": "실전 조건"}]
    assert outcome["result"]["source"] == "kiwoom"
    assert gateway.allowed == ["KR"]


def test_condition_result_serializes_pages_while_quote_receiver_stays_active(registry, monkeypatch):
    stream, gateway, clients = registry
    _enable_live_conditions(gateway, monkeypatch)
    identity = _identity("KR", "A12345")
    subscription = stream.subscribe(identity)
    _wait_until(lambda: clients and _registration(clients[0], "0B"))
    thread, outcome = _thread_call(lambda: stream.condition_result("KR", "2", timeout_seconds=0.8))
    _wait_until(lambda: any(packet.get("trnm") == "CNSRREQ" for packet in clients[0].sent))
    clients[0].incoming.put({"trnm": "REAL", "data": [{"type": "0B", "item": "A12345", "values": {"10": "+100"}}]})
    _wait_until(lambda: stream.snapshot(identity).get("last") == 100.0)
    clients[0].incoming.put({"trnm": "CNSRREQ", "return_code": 0, "seq": "2", "cont_yn": "Y", "next_key": "next", "data": [{"9001": "A005930", "302": "삼성전자", "10": "000071500"}]})
    _wait_until(lambda: len([packet for packet in clients[0].sent if packet.get("trnm") == "CNSRREQ"]) == 2)
    continuation = [packet for packet in clients[0].sent if packet.get("trnm") == "CNSRREQ"][-1]
    assert continuation["cont_yn"] == "Y" and continuation["next_key"] == "next"
    clients[0].incoming.put({"trnm": "CNSRREQ", "return_code": 0, "seq": "2", "cont_yn": "N", "data": [{"9001": "A000660", "302": "SK하이닉스", "10": "000200000"}]})
    thread.join(timeout=1.0)
    assert not thread.is_alive() and "error" not in outcome
    result = outcome["result"]
    assert result["complete"] is True and result["pages"] == 2
    assert [row["item"] for row in result["rows"]] == ["A005930", "A000660"]
    assert result["rows"][0]["fields"]["10"] == "000071500"
    assert stream.unsubscribe(subscription)


def test_condition_input_rejects_unknown_market_seq_and_us_venue(registry):
    stream, _gateway, _clients = registry
    with pytest.raises(condition_search.ConditionInputError):
        stream.condition_list("JP")
    with pytest.raises(condition_search.ConditionInputError):
        stream.condition_result("KR", "not-a-seq")
    with pytest.raises(condition_search.ConditionInputError):
        stream.condition_result("US", "1", venue="KRX")
    with pytest.raises(condition_search.ConditionInputError, match="registrationId"):
        stream.condition_unsubscribe("KR", "1", registration_id="not-a-token")
    with pytest.raises(condition_search.ConditionSearchError, match="current active owner"):
        stream.condition_unsubscribe("KR", "1", registration_id="0" * 32)


def test_condition_timeout_cancels_and_resets_ambiguous_socket_command(registry, monkeypatch):
    stream, gateway, clients = registry
    _enable_live_conditions(gateway, monkeypatch)
    thread, outcome = _thread_call(lambda: stream.condition_list("KR", timeout_seconds=0.1))
    _wait_until(lambda: clients and any(packet.get("trnm") == "CNSRLST" for packet in clients[0].sent))
    thread.join(timeout=1.0)
    assert not thread.is_alive()
    assert isinstance(outcome.get("error"), condition_search.ConditionSearchError)
    assert "timed out" in str(outcome["error"])
    _wait_until(lambda: clients[0].connected is False)


def test_live_condition_explicit_clear_and_reconnect_cancellation(registry, monkeypatch):
    stream, gateway, clients = registry
    _enable_live_conditions(gateway, monkeypatch)
    identity = _identity("KR", "A12345")
    subscription = stream.subscribe(identity)
    _wait_until(lambda: clients and _registration(clients[0], "0B"))
    thread, outcome = _thread_call(lambda: stream.condition_result("KR", "4", realtime=True, timeout_seconds=0.5))
    _wait_until(lambda: any(packet.get("trnm") == "CNSRREQ" and packet.get("search_type") == "1" for packet in clients[0].sent))
    assert "registrationId" not in next(packet for packet in clients[0].sent if packet.get("trnm") == "CNSRREQ")
    clients[0].incoming.put({"trnm": "CNSRREQ", "return_code": 0, "seq": "4", "data": [{"jmcode": "A005930"}]})
    thread.join(timeout=1.0)
    live = outcome["result"]["live"]
    assert live["state"] == "active" and live["activation"] == "explicit"
    registration_id = live["registrationId"]
    assert len(registration_id) == 32
    assert int(registration_id, 16) >= 0
    clients[0].incoming.put({"trnm": "REAL", "data": [{"type": "02", "name": "조건검색", "item": "005930", "values": {"841": "4", "9001": "005930", "843": "I", "20": "152028", "907": "2"}}]})
    _wait_until(lambda: stream.condition_status("KR", "4")["latestSequence"] == 1)
    membership = stream.condition_status("KR", "4")
    assert membership["active"] is True
    assert membership["registrationId"] == registration_id
    assert membership["events"][0]["action"] == "I"
    assert membership["events"][0]["sourceTimestamp"] is None

    clear_thread, clear_outcome = _thread_call(lambda: stream.condition_unsubscribe("KR", "4", registration_id=registration_id, timeout_seconds=0.5))
    _wait_until(lambda: any(packet.get("trnm") == "CNSRCLR" for packet in clients[0].sent))
    clients[0].incoming.put({"trnm": "CNSRCLR", "return_code": 0, "seq": "4"})
    clear_thread.join(timeout=1.0)
    assert clear_outcome["result"]["unsubscribed"] is True
    assert stream.condition_status("KR", "4")["state"] == "inactive"
    assert stream.condition_status("KR", "4")["registrationId"] is None

    inflight_thread, inflight_outcome = _thread_call(lambda: stream.condition_list("KR", timeout_seconds=0.5))
    _wait_until(lambda: len([packet for packet in clients[0].sent if packet.get("trnm") == "CNSRLST"]) == 1)
    clients[0].connected = False
    _wait_until(lambda: len(clients) == 2 and _registration(clients[1], "0B"))
    inflight_thread.join(timeout=1.0)
    assert isinstance(inflight_outcome.get("error"), condition_search.ConditionSearchError)
    assert "reconnect" in str(inflight_outcome["error"])
    assert stream.unsubscribe(subscription)


def test_condition_socket_reset_cancels_active_registration_without_replay(registry, monkeypatch):
    """A condition-command timeout resets the shared socket, losing server state.

    The already-acknowledged live condition must therefore become canceled,
    rather than remain locally active when quote registrations reconnect.
    """
    stream, gateway, clients = registry
    _enable_live_conditions(gateway, monkeypatch)
    subscription = stream.subscribe(_identity("KR", "A12345"))
    _wait_until(lambda: clients and _registration(clients[0], "0B"))

    register_thread, registered = _thread_call(
        lambda: stream.condition_result("KR", "4", realtime=True, timeout_seconds=0.5)
    )
    _wait_until(lambda: any(packet.get("trnm") == "CNSRREQ" and packet.get("search_type") == "1" for packet in clients[0].sent))
    clients[0].incoming.put({"trnm": "CNSRREQ", "return_code": 0, "seq": "4", "data": []})
    register_thread.join(timeout=1.0)
    assert registered["result"]["live"]["state"] == "active"
    assert registered["result"]["live"]["activation"] == "explicit"
    assert stream.condition_status("KR", "4")["state"] == "active"

    timeout_thread, timed_out = _thread_call(lambda: stream.condition_list("KR", timeout_seconds=0.1))
    _wait_until(lambda: any(packet.get("trnm") == "CNSRLST" for packet in clients[0].sent))
    timeout_thread.join(timeout=1.0)
    assert isinstance(timed_out.get("error"), condition_search.ConditionSearchError)
    _wait_until(lambda: len(clients) == 2 and _registration(clients[1], "0B"))

    status = stream.condition_status("KR", "4")
    assert status["active"] is False
    assert status["state"] == "canceled"
    assert status["registrationId"] is None
    assert "reconnect" in str(status["reason"])
    assert not [
        packet for packet in clients[1].sent
        if packet.get("trnm") == "CNSRREQ" and packet.get("search_type") == "1"
    ]
    assert stream.unsubscribe(subscription)


def test_condition_connection_loss_cancels_pending_and_active_states(registry):
    stream, _gateway, _clients = registry
    session = stream._Session("KR", client=FakeClient())
    with stream._lock:
        stream._condition_live[("KR", "5")] = {
            "state": "pending", "events": stream.deque(), "sequence": 0,
        }
        stream._condition_live[("KR", "6")] = {
            "state": "active", "events": stream.deque(), "sequence": 0,
        }

    asyncio.run(stream._session_failed(session, "synthetic reconnect"))

    assert stream.condition_status("KR", "5")["state"] == "canceled"
    assert stream.condition_status("KR", "6")["state"] == "canceled"
    assert stream.condition_status("KR", "6")["active"] is False


def test_live_condition_reservation_rejects_a_second_concurrent_owner(registry, monkeypatch):
    stream, gateway, clients = registry
    _enable_live_conditions(gateway, monkeypatch)
    first_thread, first = _thread_call(lambda: stream.condition_result("KR", "4", realtime=True, timeout_seconds=0.5))
    _wait_until(lambda: clients and any(packet.get("trnm") == "CNSRREQ" and packet.get("search_type") == "1" for packet in clients[0].sent))

    second_thread, second = _thread_call(lambda: stream.condition_result("KR", "4", realtime=True, timeout_seconds=0.5))
    second_thread.join(timeout=0.5)
    assert not second_thread.is_alive()
    assert isinstance(second.get("error"), condition_search.ConditionSearchError)
    assert "already registering" in str(second["error"])
    assert len([packet for packet in clients[0].sent if packet.get("trnm") == "CNSRREQ" and packet.get("search_type") == "1"]) == 1

    clients[0].incoming.put({"trnm": "CNSRREQ", "return_code": 0, "seq": "4", "data": []})
    first_thread.join(timeout=1.0)
    assert first["result"]["live"]["state"] == "active"
    assert first["result"]["live"]["activation"] == "explicit"
    assert stream.condition_status("KR", "4")["state"] == "active"


def test_live_condition_limit_is_reserved_per_market_not_globally(registry, monkeypatch):
    stream, gateway, clients = registry
    _enable_live_conditions(gateway, monkeypatch)
    with stream._lock:
        for index in range(stream.CONDITION_ACTIVE_LIMIT):
            stream._condition_live[("KR", str(index))] = {"state": "active", "events": stream.deque(), "sequence": 0}

    with pytest.raises(condition_search.ConditionSearchError, match="per market"):
        stream.condition_result("KR", "99", realtime=True, timeout_seconds=0.5)

    us_thread, us = _thread_call(lambda: stream.condition_result("US", "99", realtime=True, timeout_seconds=0.5))
    _wait_until(lambda: any(packet.get("trnm") == "GCNSRREQ" and packet.get("search_type") == "1" for client in clients for packet in client.sent))
    us_client = next(client for client in clients if any(packet.get("trnm") == "GCNSRREQ" for packet in client.sent))
    us_client.incoming.put({"trnm": "GCNSRREQ", "return_code": 0, "seq": "99", "data": []})
    us_thread.join(timeout=1.0)
    assert us["result"]["live"]["state"] == "active"
    assert us["result"]["live"]["activation"] == "explicit"
    assert stream.condition_status("US", "99")["state"] == "active"


def test_stale_condition_owner_cannot_clear_replacement_after_socket_reset(registry, monkeypatch):
    """An old panel's clear must not unregister a same-seq replacement."""
    stream, gateway, clients = registry
    _enable_live_conditions(gateway, monkeypatch)
    subscription = stream.subscribe(_identity("KR", "A12345"))
    _wait_until(lambda: clients and _registration(clients[0], "0B"))

    first_thread, first = _thread_call(lambda: stream.condition_result("KR", "4", realtime=True, timeout_seconds=0.5))
    _wait_until(lambda: any(packet.get("trnm") == "CNSRREQ" and packet.get("search_type") == "1" for packet in clients[0].sent))
    clients[0].incoming.put({"trnm": "CNSRREQ", "return_code": 0, "seq": "4", "data": []})
    first_thread.join(timeout=1.0)
    first_id = first["result"]["live"]["registrationId"]

    reset_thread, reset = _thread_call(lambda: stream.condition_list("KR", timeout_seconds=0.1))
    _wait_until(lambda: any(packet.get("trnm") == "CNSRLST" for packet in clients[0].sent))
    reset_thread.join(timeout=1.0)
    assert isinstance(reset.get("error"), condition_search.ConditionSearchError)
    _wait_until(lambda: len(clients) == 2 and _registration(clients[1], "0B"))

    replacement_thread, replacement = _thread_call(lambda: stream.condition_result("KR", "4", realtime=True, timeout_seconds=0.5))
    _wait_until(lambda: any(packet.get("trnm") == "CNSRREQ" and packet.get("search_type") == "1" for packet in clients[1].sent))
    clients[1].incoming.put({"trnm": "CNSRREQ", "return_code": 0, "seq": "4", "data": []})
    replacement_thread.join(timeout=1.0)
    replacement_id = replacement["result"]["live"]["registrationId"]
    assert replacement_id != first_id

    with pytest.raises(condition_search.ConditionSearchError, match="current active owner"):
        stream.condition_unsubscribe("KR", "4", registration_id=first_id)
    assert not [packet for packet in clients[1].sent if packet.get("trnm") == "CNSRCLR"]
    status = stream.condition_status("KR", "4")
    assert status["state"] == "active" and status["registrationId"] == replacement_id
    assert stream.unsubscribe(subscription)


def test_stale_queued_condition_command_never_reaches_broker(registry):
    stream, _gateway, _clients = registry
    stale_id, replacement_id = "a" * 32, "b" * 32
    spec = condition_search.build_command("KR", "unsubscribe", seq="4")
    command = stream._ConditionCommand(
        spec=spec,
        deadline=time.monotonic() + 1.0,
        registration_id=stale_id,
        packet=dict(spec.packet),
    )
    with stream._lock:
        stream._condition_live[("KR", "4")] = {
            "registrationId": replacement_id,
            "state": "active",
            "events": stream.deque(),
            "sequence": 0,
        }
        stream._condition_queues["KR"].append(command)
    client = FakeClient()

    asyncio.run(stream._condition_tick(stream._Session("KR", client=client)))

    assert client.sent == []
    assert command.done.is_set()
    assert isinstance(command.error, condition_search.ConditionSearchError)
    status = stream.condition_status("KR", "4")
    assert status["state"] == "active" and status["registrationId"] == replacement_id


def test_late_live_ack_and_stale_pending_cleanup_cannot_overwrite_replacement(registry):
    stream, _gateway, _clients = registry
    stale_id, replacement_id = "a" * 32, "b" * 32
    spec = condition_search.build_command("KR", "live", seq="4")
    command = stream._ConditionCommand(
        spec=spec,
        deadline=time.monotonic() + 1.0,
        registration_id=stale_id,
        packet=dict(spec.packet),
    )
    with stream._lock:
        stream._condition_live[("KR", "4")] = {
            "registrationId": replacement_id,
            "state": "active",
            "events": stream.deque(),
            "sequence": 0,
        }
        stream._condition_inflight["KR"] = command

    assert stream._handle_condition_message(
        stream._Session("KR", client=FakeClient()),
        {"trnm": "CNSRREQ", "return_code": 0, "seq": "4", "data": []},
    ) is True
    assert isinstance(command.error, condition_search.ConditionSearchError)
    status = stream.condition_status("KR", "4")
    assert status["state"] == "active" and status["registrationId"] == replacement_id

    with stream._lock:
        stream._condition_live[("KR", "4")].update({"state": "pending"})
    stream._release_live_reservation("KR", "4", stale_id)
    assert stream.condition_status("KR", "4")["registrationId"] == replacement_id
