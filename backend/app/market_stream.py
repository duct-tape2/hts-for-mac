"""Read-only, ref-counted Kiwoom market-data subscriptions.

The worker deliberately uses the official SDK instead of implementing OAuth,
LOGIN, PING, websocket parsing, or realtime framing itself.  The small amount
of packet assembly below is limited to the four public market-data types
documented in the official repository:

* https://github.com/Kiwoom-Securities/Kiwoom-REST-API
* https://github.com/Kiwoom-Securities/Kiwoom-REST-API/tree/main/examples

KR and US use different documented WebSocket paths, so one worker owns up to
two SDK clients.  Whether one token may hold both sessions concurrently is not
documented by the SDK examples and has not been verified against a broker.

This module never reads credentials, environment variables, token stores,
Keychain, or files.  Credential selection and the outbound transport remain
behind ``app.kiwoom_gateway``.  It also never registers account/order events.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from collections import deque
import logging
import math
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from kiwoom.realtime import build_reg_packet as _sdk_build_reg_packet
from kiwoom.realtime import build_remove_packet as _sdk_build_remove_packet

from app import condition_search
from app import kiwoom_gateway as gateway


logger = logging.getLogger(__name__)

MAX_INSTRUMENTS = 200
EVENT_JOURNAL_LIMIT = 256
FRESH_SECONDS = 10.0
BOOK_FRESH_SECONDS = 5.0
CONNECT_TIMEOUT_SECONDS = 5.0
CLOSE_TIMEOUT_SECONDS = 2.0
RETRY_INITIAL_SECONDS = 1.0
RETRY_MAX_SECONDS = 30.0
CONDITION_TIMEOUT_SECONDS = 5.0
CONDITION_MAX_PAGES = 5
CONDITION_EVENT_LIMIT = 256
CONDITION_STATE_LIMIT = 64
CONDITION_ACTIVE_LIMIT = 10
_KR_CODE = re.compile(r"^[0-9A-Z]{6}$")
_US_CODE = re.compile(r"^[A-Z][A-Z0-9.]{0,14}$")
_REGISTRATION_ID = re.compile(r"^[0-9a-f]{32}$")
_REQUIRED_IDENTITY = ("environment", "market", "stkCd", "listingVenue", "quoteVenue", "stexTp")
_PATHS = {"KR": "/api/dostk/websocket", "US": "/api/us/websocket"}
_TYPES = {"KR": ("0B", "0D"), "US": ("FE", "FT")}

# The official examples use the same FID layout for the public trade and book
# feeds.  These labels are passed to the SDK normalizer, not used to decode raw
# frames ourselves.
_TRADE_COLUMNS = {
    "10": "last", "11": "change", "12": "changePct", "13": "volume",
    "20": "tradeTime", "22": "tradeDate", "51020": "localTradeTime",
}
_BOOK_COLUMNS = {
    **{str(40 + level): f"ask{level}" for level in range(1, 11)},
    **{str(60 + level): f"ask{level}qty" for level in range(1, 11)},
    **{str(50 + level): f"bid{level}" for level in range(1, 11)},
    **{str(70 + level): f"bid{level}qty" for level in range(1, 11)},
}
_COLUMNS = {**_TRADE_COLUMNS, **_BOOK_COLUMNS}


class SubscriptionError(RuntimeError):
    """A bounded, safe-to-display realtime registration error."""


class IdentityError(SubscriptionError):
    """The caller supplied an incomplete or inconsistent market identity."""


class _WorkerStopping(RuntimeError):
    """Internal signal used to stop an in-flight SDK operation cleanly."""


class _AuthRefreshRequired(RuntimeError):
    """The SDK observed an auth-login failure using a pinned token."""


@dataclass
class _Instrument:
    identity: dict[str, str]
    refcount: int = 0
    snapshot: dict[str, Any] = field(default_factory=dict)
    events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=EVENT_JOURNAL_LIMIT))


@dataclass
class _Session:
    market: str
    client: Any | None = None
    registered: set[tuple[str, ...]] = field(default_factory=set)
    registered_identities: dict[tuple[str, ...], dict[str, str]] = field(default_factory=dict)
    state: str = "idle"
    error: str = ""
    retry_delay: float = RETRY_INITIAL_SECONDS
    next_retry_at: float = 0.0
    auth_generation: int = 0


@dataclass
class _ConditionCommand:
    spec: condition_search.ConditionCommandSpec
    deadline: float
    # This local ownership token is deliberately never included in SDK packets.
    # It protects a newly-created registration from a stale caller's cleanup.
    registration_id: str | None = None
    done: threading.Event = field(default_factory=threading.Event)
    packet: dict[str, str] = field(default_factory=dict)
    pages: list[dict[str, Any]] = field(default_factory=list)
    awaiting_response: bool = False
    result: dict[str, Any] | None = None
    error: Exception | None = None


_lock = threading.RLock()
_subscribers: dict[str, tuple[str, ...]] = {}
_instruments: dict[tuple[str, ...], _Instrument] = {}
_thread: threading.Thread | None = None
_stop_event = threading.Event()
_worker_running = False
_stopping = False
_market_state = {market: {"state": "idle", "error": ""} for market in _PATHS}
_auth_generation = 0
_condition_queues: dict[str, deque[_ConditionCommand]] = {market: deque() for market in _PATHS}
_condition_inflight: dict[str, _ConditionCommand | None] = {market: None for market in _PATHS}
_condition_reset_requested: set[str] = set()
_condition_live: dict[tuple[str, str], dict[str, Any]] = {}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _monotonic() -> float:
    """A small seam for deterministic reconnect-pacing tests."""
    return time.monotonic()


def _identity_key(identity: dict[str, str]) -> tuple[str, ...]:
    return tuple(identity[field] for field in _REQUIRED_IDENTITY)


def _configured_environment() -> str:
    """Read only the gateway's backend-owned runtime selection."""
    return str(getattr(gateway, "ENVIRONMENT", "")).strip().lower()


def _canonical_identity(raw: dict[str, Any]) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise IdentityError("identity must be an object")
    if any(raw.get(field) in (None, "") for field in _REQUIRED_IDENTITY):
        raise IdentityError("identity requires environment, market, stkCd, listingVenue, quoteVenue, and stexTp")

    identity = {field: str(raw[field]).strip() for field in _REQUIRED_IDENTITY}
    identity["environment"] = identity["environment"].lower()
    identity["market"] = identity["market"].upper()
    identity["stkCd"] = identity["stkCd"].upper()
    identity["listingVenue"] = identity["listingVenue"].upper()
    identity["quoteVenue"] = identity["quoteVenue"].upper()
    identity["stexTp"] = identity["stexTp"].upper()

    configured = _configured_environment()
    if not configured or identity["environment"] != configured:
        raise IdentityError("identity environment does not match the backend runtime")
    if identity["market"] == "KR":
        if not _KR_CODE.fullmatch(identity["stkCd"]):
            raise IdentityError("KR stkCd must be six uppercase alphanumeric characters")
        if identity["stexTp"] != "KRX" or identity["quoteVenue"] != "KRX":
            raise IdentityError("KR stexTp and quoteVenue must be KRX")
        if identity["listingVenue"] not in {"KOSPI", "KOSDAQ"}:
            raise IdentityError("KR listingVenue is unsupported")
    elif identity["market"] == "US":
        if not _US_CODE.fullmatch(identity["stkCd"]):
            raise IdentityError("US stkCd is invalid")
        if identity["stexTp"] not in {"ND", "NY", "NA"} or identity["quoteVenue"] != identity["stexTp"]:
            raise IdentityError("US quoteVenue and stexTp must be the same official exchange code")
        expected_listing = {"ND": "NASDAQ", "NY": "NYSE", "NA": "AMEX"}[identity["stexTp"]]
        if identity["listingVenue"] != expected_listing:
            raise IdentityError("US listingVenue does not match stexTp")
    else:
        raise IdentityError("market must be KR or US")
    return identity


def _initial_snapshot(identity: dict[str, str]) -> dict[str, Any]:
    return {
        **identity,
        "status": "pending",
        "bookLive": False,
        "receivedAt": None,
        "tradeReceivedAt": None,
        "bookReceivedAt": None,
        "priceReceivedAt": None,
        "volumeReceivedAt": None,
        "tradeSourceTime": None,
        "bookSourceTime": None,
        "observedOhlc": None,
        "observedMinute": None,
        "eventJournalGap": None,
        "sourceTimestamp": None,
        "note": "Awaiting a broker market-data event.",
    }


def _retire_stopped_thread_locked() -> None:
    global _thread, _stopping
    if _thread is None or not _thread.is_alive():
        _thread = None
        _stopping = False


def start() -> None:
    """Start the one async worker only when a subscription or command needs it."""
    global _thread
    with _lock:
        _retire_stopped_thread_locked()
        if _thread is not None and _thread.is_alive():
            return
        # ``main`` invokes this at application startup, but an idle worker has
        # no socket or queue to service. Avoid creating one that can overlap a
        # just-stopped test/application worker during lifecycle handoff. Quote
        # subscription and saved-condition submission both register their work
        # before calling ``start``.
        has_condition_work = any(
            _condition_queues[market]
            or _condition_inflight[market] is not None
            or any(key[0] == market and state.get("state") == "active" for key, state in _condition_live.items())
            for market in _PATHS
        )
        if not _instruments and not has_condition_work:
            return
        _stop_event.clear()
        _thread = threading.Thread(target=_thread_main, name="kiwoom-market-stream", daemon=True)
        _thread.start()


def stop() -> None:
    """Stop the worker and discard all bounded, in-memory subscription state."""
    global _thread, _stopping
    with _lock:
        _stopping = True
        for market in _PATHS:
            _cancel_market_conditions_locked(market, "market stream worker stopped")
    _stop_event.set()
    thread = _thread
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=2.0)
    with _lock:
        # Do not clear this reference while a blocked SDK operation unwinds:
        # ``start`` must never create a second worker beside an old one.
        _retire_stopped_thread_locked()
        _subscribers.clear()
        _instruments.clear()
        _condition_reset_requested.clear()
        for market in _market_state:
            _market_state[market] = {"state": "idle", "error": ""}


def subscribe(identity: dict[str, Any]) -> str:
    """Ref-count an instrument and return an opaque subscriber identifier."""
    canonical = _canonical_identity(identity)
    key = _identity_key(canonical)
    with _lock:
        _retire_stopped_thread_locked()
        if _stopping:
            raise SubscriptionError("realtime worker is stopping")
        instrument = _instruments.get(key)
        if instrument is None:
            if len(_instruments) >= MAX_INSTRUMENTS:
                raise SubscriptionError(f"realtime instrument limit is {MAX_INSTRUMENTS}")
            instrument = _Instrument(identity=canonical, snapshot=_initial_snapshot(canonical))
            _instruments[key] = instrument
        instrument.refcount += 1
        subscriber_id = uuid.uuid4().hex
        _subscribers[subscriber_id] = key
    start()
    return subscriber_id


def unsubscribe(subscriber_id: str) -> bool:
    """Release one viewer.  The final viewer causes a REMOVE on the worker."""
    with _lock:
        key = _subscribers.pop(str(subscriber_id), None)
        if key is None:
            return False
        instrument = _instruments.get(key)
        if instrument is None:  # Defensive: never retain a dangling refcount.
            return False
        instrument.refcount -= 1
        if instrument.refcount <= 0:
            del _instruments[key]
        return True


def snapshot(identity: dict[str, Any]) -> dict[str, Any] | None:
    """Return an identity-scoped, freshness-aware copy; never a synthetic quote."""
    key = _identity_key(_canonical_identity(identity))
    with _lock:
        instrument = _instruments.get(key)
        if instrument is None:
            return None
        return _public_snapshot(instrument.snapshot)


def status() -> dict[str, Any]:
    """Return bounded operational state without credentials, frames, or tokens."""
    with _lock:
        by_market = {
            market: {
                "activeInstruments": sum(1 for instrument in _instruments.values() if instrument.identity["market"] == market),
                "connection": _market_state[market]["state"],
                "error": _market_state[market]["error"],
            }
            for market in _PATHS
        }
        return {
            "running": bool(_thread and _thread.is_alive() and _worker_running),
            "activeSubscribers": len(_subscribers),
            "activeInstruments": len(_instruments),
            "maxInstruments": MAX_INSTRUMENTS,
            "markets": by_market,
            "sameTokenMultiSession": "unverified",
        }


def auth_generation_changed(generation: int) -> None:
    """Wake active sessions after a successful shared-token rotation.

    Subscription ownership stays in ``_instruments``; each market loop sees
    this monotonically increasing generation and reconnects once, then
    re-registers its still-active identities through its normal sync path.
    """
    global _auth_generation
    with _lock:
        if generation <= _auth_generation:
            return
        _auth_generation = generation


def _public_snapshot(stored: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy({key: value for key, value in stored.items() if not key.startswith("_")})
    now = _monotonic()
    trade_at = float(stored.get("_tradeMonotonic") or 0.0)
    volume_at = float(stored.get("_volumeMonotonic") or 0.0)
    book_at = float(stored.get("_bookMonotonic") or 0.0)
    has_data = bool(trade_at or volume_at or book_at)
    book_live = bool(book_at and now - book_at <= BOOK_FRESH_SECONDS)
    price_live = bool(trade_at and now - trade_at <= FRESH_SECONDS)
    volume_live = bool(volume_at and now - volume_at <= FRESH_SECONDS)
    fresh = bool(max(trade_at, volume_at, book_at) and now - max(trade_at, volume_at, book_at) <= FRESH_SECONDS)
    current = str(stored.get("status") or "pending")
    if current == "subscription-error" and not fresh:
        status_value = "subscription-error"
    elif current == "stale":
        status_value = "stale"
        book_live = False
        price_live = False
        volume_live = False
    elif not has_data:
        status_value = current if current in {"pending", "subscription-error"} else "pending"
    elif fresh:
        status_value = "live"
    else:
        status_value = "stale"
        if current != "subscription-error":
            result["note"] = "No recent broker market-data event."
    result["status"] = status_value
    result["bookLive"] = book_live
    result["priceLive"] = price_live
    result["volumeLive"] = volume_live
    return result


def event_journal(identity: dict[str, Any], *, after_sequence: int | None = None, limit: int = EVENT_JOURNAL_LIMIT) -> dict[str, Any] | None:
    """Read a bounded, arrival-ordered market-event tape for one active identity.

    ``sequence`` is a local process arrival counter, not a broker/exchange
    sequence or a proof of transaction ordering.  ``gap`` reports that the
    requested cursor predates the retained bounded journal.
    """
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= EVENT_JOURNAL_LIMIT:
        raise SubscriptionError(f"event journal limit must be between 1 and {EVENT_JOURNAL_LIMIT}")
    if after_sequence is not None and (isinstance(after_sequence, bool) or not isinstance(after_sequence, int) or after_sequence < 0):
        raise SubscriptionError("event journal cursor must be a non-negative integer")
    canonical = _canonical_identity(identity)
    key = _identity_key(canonical)
    with _lock:
        instrument = _instruments.get(key)
        if instrument is None:
            return None
        retained = list(instrument.events)
        oldest = retained[0]["sequence"] if retained else None
        latest = retained[-1]["sequence"] if retained else int(instrument.snapshot.get("_arrivalSequence") or 0)
        selected = [event for event in retained if after_sequence is None or event["sequence"] > after_sequence]
        truncated = len(selected) > limit
        if truncated:
            selected = selected[-limit:]
        return {
            "identity": dict(canonical),
            "events": deepcopy(selected),
            "oldestSequence": oldest,
            "latestSequence": latest,
            "gap": bool(after_sequence is not None and oldest is not None and after_sequence < oldest - 1),
            "truncated": truncated,
            "transportGap": deepcopy(instrument.snapshot.get("eventJournalGap")),
            "retention": EVENT_JOURNAL_LIMIT,
            "sequenceSemantics": "local process arrival order; not provider or exchange order",
        }


def event_metadata(identity: dict[str, Any]) -> dict[str, Any] | None:
    """Return non-sensitive metadata for the active identity's bounded tape."""
    canonical = _canonical_identity(identity)
    key = _identity_key(canonical)
    with _lock:
        instrument = _instruments.get(key)
        if instrument is None:
            return None
        stored = instrument.snapshot
        return {
            "identity": dict(canonical),
            "latestSequence": int(stored.get("_arrivalSequence") or 0),
            "retainedEvents": len(instrument.events),
            "retention": EVENT_JOURNAL_LIMIT,
            "sequenceSemantics": "local process arrival order; not provider or exchange order",
            "receivedAt": stored.get("receivedAt"),
            "priceReceivedAt": stored.get("priceReceivedAt"),
            "volumeReceivedAt": stored.get("volumeReceivedAt"),
            "tradeReceivedAt": stored.get("tradeReceivedAt"),
            "bookReceivedAt": stored.get("bookReceivedAt"),
            "tradeSourceTime": deepcopy(stored.get("tradeSourceTime")),
            "bookSourceTime": deepcopy(stored.get("bookSourceTime")),
            "observedOhlc": deepcopy(stored.get("observedOhlc")),
            "observedMinute": deepcopy(stored.get("observedMinute")),
            "eventJournalGap": deepcopy(stored.get("eventJournalGap")),
        }


def _condition_timeout(timeout_seconds: float) -> float:
    try:
        value = float(timeout_seconds)
    except (TypeError, ValueError) as exc:
        raise condition_search.ConditionInputError("condition timeout must be numeric") from exc
    if not math.isfinite(value) or not 0 < value <= CONDITION_TIMEOUT_SECONDS:
        raise condition_search.ConditionInputError(f"condition timeout must be between 0 and {CONDITION_TIMEOUT_SECONDS:g} seconds")
    return value


def _condition_fixture_mode() -> bool:
    return str(getattr(gateway, "ENVIRONMENT", "")).strip().lower() == "fixture"


def _require_condition_transport() -> None:
    if not bool(getattr(gateway, "KIWOOM_ENABLED", False)):
        raise condition_search.ConditionSearchError("saved-condition broker reads are disabled")


def _condition_status_payload(market: str, seq: str) -> dict[str, Any]:
    if _condition_fixture_mode():
        return {"market": market, "seq": seq, "active": False, "state": "fixture", "registrationId": None, "events": [], "latestSequence": 0, "retention": CONDITION_EVENT_LIMIT, "note": "Fixture mode has no live saved-condition registration."}
    with _lock:
        state = _condition_live.get((market, seq))
        if state is None:
            return {"market": market, "seq": seq, "active": False, "state": "inactive", "registrationId": None, "events": [], "latestSequence": 0, "retention": CONDITION_EVENT_LIMIT, "note": "No active saved-condition registration."}
        current = state.get("registrationId") if state.get("state") in {"pending", "active"} else None
        return {
            "market": market,
            "seq": seq,
            "active": state.get("state") == "active",
            "state": state.get("state", "inactive"),
            "registrationId": current,
            "events": deepcopy(list(state.get("events", ()))),
            "latestSequence": int(state.get("sequence") or 0),
            "retention": CONDITION_EVENT_LIMIT,
            "reason": state.get("reason"),
            "updatedAt": state.get("updatedAt"),
            "note": state.get("note", ""),
        }


def condition_list(market: str, *, timeout_seconds: float = CONDITION_TIMEOUT_SECONDS) -> dict[str, Any]:
    """List broker-saved conditions through the existing market-stream socket."""
    selected = condition_search.normalize_market(market)
    timeout = _condition_timeout(timeout_seconds)
    if _condition_fixture_mode():
        return condition_search.fixture_list(selected)
    _require_condition_transport()
    return _submit_condition(condition_search.build_command(selected, "list"), timeout)


def condition_result(market: str, seq: str, *, venue: str | None = None, realtime: bool = False, timeout_seconds: float = CONDITION_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Read one saved condition; live registration requires ``realtime=True``."""
    selected = condition_search.normalize_market(market)
    normalized_seq = condition_search.normalize_seq(seq)
    if not isinstance(realtime, bool):
        raise condition_search.ConditionInputError("condition realtime must be boolean")
    operation = "live" if realtime else "result"
    spec = condition_search.build_command(selected, operation, seq=normalized_seq, venue=venue)
    timeout = _condition_timeout(timeout_seconds)
    if _condition_fixture_mode():
        return condition_search.fixture_result(selected, normalized_seq, realtime=realtime)
    _require_condition_transport()
    if not realtime:
        return _submit_condition(spec, timeout)
    registration_id = _reserve_live_condition(selected, normalized_seq)
    try:
        return _submit_condition(spec, timeout, registration_id=registration_id)
    except BaseException:
        _release_live_reservation(selected, normalized_seq, registration_id)
        raise


def _reserve_live_condition(market: str, seq: str) -> str:
    """Atomically claim one explicit registration before it can be queued."""
    with _lock:
        _prune_condition_states_locked()
        key = (market, seq)
        existing = _condition_live.get(key)
        if existing is not None and existing.get("state") in {"pending", "active"}:
            raise condition_search.ConditionSearchError("saved condition is already registering or active")
        used = sum(
            1
            for (state_market, _), state in _condition_live.items()
            if state_market == market and state.get("state") in {"pending", "active"}
        )
        if used >= CONDITION_ACTIVE_LIMIT:
            raise condition_search.ConditionSearchError(f"live saved-condition limit is {CONDITION_ACTIVE_LIMIT} per market")
        registration_id = uuid.uuid4().hex
        _condition_live[key] = {
            "registrationId": registration_id,
            "registeredAt": None,
            "updatedAt": _utc_now(),
            "state": "pending",
            "reason": None,
            "note": "Live membership registration is awaiting broker acknowledgement.",
            "sequence": 0,
            "events": deque(maxlen=CONDITION_EVENT_LIMIT),
        }
        return registration_id


def _release_live_reservation(market: str, seq: str, registration_id: str) -> None:
    with _lock:
        key = (market, seq)
        state = _condition_live.get(key, {})
        if state.get("state") == "pending" and state.get("registrationId") == registration_id:
            del _condition_live[key]


def _normalize_registration_id(value: str) -> str:
    if not isinstance(value, str) or _REGISTRATION_ID.fullmatch(value) is None:
        raise condition_search.ConditionInputError("condition registrationId must be 32 lowercase hexadecimal characters")
    return value


def _condition_command_owner_matches_locked(command: _ConditionCommand) -> bool:
    """Return whether a live command still owns its current registration."""
    if command.registration_id is None:
        return True
    expected_state = "pending" if command.spec.realtime else "active" if command.spec.operation == "unsubscribe" else None
    if expected_state is None:
        return False
    state = _condition_live.get((command.spec.market, command.spec.seq or ""))
    return bool(state and state.get("state") == expected_state and state.get("registrationId") == command.registration_id)


def condition_unsubscribe(market: str, seq: str, *, registration_id: str, timeout_seconds: float = CONDITION_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Explicitly clear a live saved-condition registration on its market socket."""
    selected, normalized_seq = condition_search.normalize_market(market), condition_search.normalize_seq(seq)
    normalized_registration_id = _normalize_registration_id(registration_id)
    with _lock:
        state = _condition_live.get((selected, normalized_seq), {})
        if state.get("state") != "active" or state.get("registrationId") != normalized_registration_id:
            raise condition_search.ConditionSearchError("saved condition registration is not the current active owner")
    timeout = _condition_timeout(timeout_seconds)
    _require_condition_transport()
    return _submit_condition(
        condition_search.build_command(selected, "unsubscribe", seq=normalized_seq),
        timeout,
        registration_id=normalized_registration_id,
    )


def condition_status(market: str, seq: str) -> dict[str, Any]:
    """Read bounded live-membership state; this never creates a subscription."""
    return _condition_status_payload(condition_search.normalize_market(market), condition_search.normalize_seq(seq))


def _finish_condition_locked(command: _ConditionCommand, *, result: dict[str, Any] | None = None, error: Exception | None = None) -> None:
    if command.done.is_set():
        return
    command.result, command.error = result, error
    command.done.set()


def _cancel_market_conditions_locked(market: str, message: str) -> None:
    while _condition_queues[market]:
        _finish_condition_locked(_condition_queues[market].popleft(), error=condition_search.ConditionSearchError(message))
    command = _condition_inflight[market]
    _condition_inflight[market] = None
    if command is not None:
        _finish_condition_locked(command, error=condition_search.ConditionSearchError(message))
    for key, state in _condition_live.items():
        if key[0] == market and state.get("state") in {"pending", "active"}:
            state.update({"state": "canceled", "reason": message, "updatedAt": _utc_now(), "note": "Realtime connection changed; subscribe again to receive new membership events."})


def _cancel_condition(command: _ConditionCommand, message: str) -> None:
    with _lock:
        market = command.spec.market
        try:
            _condition_queues[market].remove(command)
        except ValueError:
            pass
        if _condition_inflight[market] is command:
            _condition_inflight[market] = None
            # Without a protocol request ID, a late response cannot safely be
            # attributed to a subsequent command on this connection.
            if _condition_command_owner_matches_locked(command):
                _condition_reset_requested.add(market)
        _finish_condition_locked(command, error=condition_search.ConditionSearchError(message))


def _submit_condition(spec: condition_search.ConditionCommandSpec, timeout_seconds: float, *, registration_id: str | None = None) -> dict[str, Any]:
    command = _ConditionCommand(spec=spec, deadline=_monotonic() + timeout_seconds, registration_id=registration_id, packet=dict(spec.packet))
    with _lock:
        _retire_stopped_thread_locked()
        if _stopping:
            raise condition_search.ConditionSearchError("market stream worker is stopping")
        if not _condition_command_owner_matches_locked(command):
            raise condition_search.ConditionSearchError("saved condition registration ownership changed")
        _condition_queues[spec.market].append(command)
    start()
    if not command.done.wait(timeout_seconds):
        _cancel_condition(command, "saved-condition request timed out")
    if command.error is not None:
        raise command.error
    if command.result is None:
        raise condition_search.ConditionSearchError("saved-condition request ended without a result")
    return {**command.result, "source": "kiwoom", "status": "snapshot", "receivedAt": _utc_now()}


def _thread_main() -> None:
    asyncio.run(_worker())


async def _worker() -> None:
    global _worker_running
    sessions = {market: _Session(market) for market in _PATHS}
    with _lock:
        _worker_running = True
    tasks = [asyncio.create_task(_market_loop(session), name=f"kiwoom-market-{market.lower()}") for market, session in sessions.items()]
    try:
        while not _stop_event.is_set():
            await asyncio.sleep(0.05)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        with _lock:
            _worker_running = False


async def _market_loop(session: _Session) -> None:
    """Own one market client without letting another market's retry block it."""
    try:
        while not _stop_event.is_set():
            desired = _desired_for_market(session.market)
            try:
                if _take_condition_reset(session.market):
                    # A reset deliberately drops the socket because an
                    # outstanding condition reply cannot be safely matched.
                    # The broker also drops every condition registration on
                    # that socket, so local state cannot stay usable or be
                    # replayed implicitly after reconnect.
                    with _lock:
                        _cancel_market_conditions_locked(
                            session.market,
                            "saved-condition request canceled by realtime reconnect",
                        )
                    await _close_session(session, remove=False)
                    await asyncio.sleep(0.02)
                    continue
                if not desired and not _condition_has_work(session.market):
                    await _close_session(session, remove=True)
                    _set_market_state(session.market, "idle", "")
                    await asyncio.sleep(0.02)
                    continue
                if _monotonic() < session.next_retry_at:
                    await asyncio.sleep(0.02)
                    continue
                await _ensure_connected(session)
                await _sync_session(session, desired)
                await _condition_tick(session)
                await _receive_once(session)
            except _WorkerStopping:
                break
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("market realtime %s loop failure", session.market, exc_info=False)
                await _session_failed(session, "Realtime connection unavailable.")
            await asyncio.sleep(0.02)
    finally:
        await _close_session(session, remove=True)


def _desired_for_market(market: str) -> dict[tuple[str, ...], dict[str, str]]:
    with _lock:
        return {
            key: dict(instrument.identity)
            for key, instrument in _instruments.items()
            if instrument.identity["market"] == market
        }


def _condition_has_work(market: str) -> bool:
    with _lock:
        return bool(_condition_queues[market] or _condition_inflight[market] or any(key[0] == market and state.get("state") == "active" for key, state in _condition_live.items()))


def _prune_condition_states_locked() -> None:
    while len(_condition_live) >= CONDITION_STATE_LIMIT:
        inactive = [(str(state.get("updatedAt") or ""), key) for key, state in _condition_live.items() if state.get("state") != "active"]
        if not inactive:
            return
        _, key = min(inactive)
        del _condition_live[key]


def _take_condition_reset(market: str) -> bool:
    with _lock:
        if market not in _condition_reset_requested:
            return False
        _condition_reset_requested.remove(market)
        return True


async def _condition_tick(session: _Session) -> None:
    """Send at most one condition packet and never await a second reply."""
    if session.client is None:
        return
    packet: dict[str, str] | None = None
    with _lock:
        command = _condition_inflight[session.market]
        if command is not None and not _condition_command_owner_matches_locked(command):
            _condition_inflight[session.market] = None
            _finish_condition_locked(command, error=condition_search.ConditionSearchError("saved condition registration ownership changed"))
            return
        if command is not None and _monotonic() >= command.deadline:
            _condition_inflight[session.market] = None
            _condition_reset_requested.add(session.market)
            _finish_condition_locked(command, error=condition_search.ConditionSearchError("saved-condition request timed out"))
            return
        if command is None:
            while _condition_queues[session.market] and _condition_queues[session.market][0].done.is_set():
                _condition_queues[session.market].popleft()
            if _condition_queues[session.market]:
                command = _condition_queues[session.market].popleft()
                _condition_inflight[session.market] = command
                if not _condition_command_owner_matches_locked(command):
                    _condition_inflight[session.market] = None
                    _finish_condition_locked(command, error=condition_search.ConditionSearchError("saved condition registration ownership changed"))
                    return
        if command is not None and not command.awaiting_response:
            command.awaiting_response = True
            packet = dict(command.packet)
    if packet is not None:
        # A reconnect or a newer reservation may have changed ownership after
        # dequeueing.  Do not put an obsolete broker command on the wire.
        with _lock:
            if command is None or _condition_inflight[session.market] is not command or not _condition_command_owner_matches_locked(command):
                if command is not None and _condition_inflight[session.market] is command:
                    _condition_inflight[session.market] = None
                    _finish_condition_locked(command, error=condition_search.ConditionSearchError("saved condition registration ownership changed"))
                return
        await session.client.send(packet)


async def _ensure_connected(session: _Session) -> None:
    with _lock:
        current_generation = _auth_generation
    if session.client is not None and bool(getattr(session.client, "is_connected", False)) and session.auth_generation == current_generation:
        return
    was_disconnected = session.client is not None
    await _close_session(session, remove=False)
    if was_disconnected:
        with _lock:
            _cancel_market_conditions_locked(session.market, "saved-condition request canceled by realtime reconnect")
        _mark_market_stale(session.market, "Realtime authentication reconnecting.")
    # This policy gate intentionally precedes SDK client construction, token
    # lookup, and socket creation.
    gateway.assert_realtime_allowed(market=session.market)
    auth_generation: int | None = None
    if bool(getattr(gateway, "KIWOOM_ENABLED", False)):
        token, auth_generation = await asyncio.to_thread(gateway.websocket_auth_snapshot)
        client = _sdk_get_ws_client(token)
    else:
        client = _sdk_get_ws_client()
    client._connect_factory = gateway.open_realtime
    try:
        await _await_connect(client, _PATHS[session.market])
    except _AuthRefreshRequired:
        await _close_unowned_client(client)
        if auth_generation is None:
            raise
        # The official client had already retried one pinned LOGIN token. Its
        # real shared-token recovery now occurs off this async event loop.
        token, auth_generation = await asyncio.to_thread(gateway.recover_websocket_auth, auth_generation)
        client = _sdk_get_ws_client(token)
        client._connect_factory = gateway.open_realtime
        try:
            await _await_connect(client, _PATHS[session.market])
        except BaseException:
            await _close_unowned_client(client)
            raise
    except BaseException:
        # The SDK can leave an opened socket behind after a failed LOGIN or
        # timeout. It is not yet owned by ``session``, so close it here.
        await _close_unowned_client(client)
        raise
    session.client = client
    session.registered.clear()
    # Stamp the generation that selected this LOGIN token. If another thread
    # rotated while connect awaited I/O, the next loop iteration sees a stale
    # generation and reconnects instead of treating an old-login socket as new.
    if auth_generation is None:
        with _lock:
            session.auth_generation = _auth_generation
    else:
        session.auth_generation = auth_generation
    session.state, session.error = "connected", ""
    _set_market_state(session.market, "connected", "")


async def _await_connect(client: Any, api_url: str) -> None:
    """Bound connect time and cancel promptly when the owner stops."""
    # SDK WebSocket connect normally retries auth synchronously. Pinned auth
    # returns immediately and signals the worker, which offloads the real
    # refresh above. Injectable test clients retain their historical signature.
    kwargs: dict[str, Any] = {"api_url": api_url}
    if hasattr(getattr(client, "auth", None), "auth_retry_requested"):
        kwargs["retry_on_auth_failure"] = True
    task = asyncio.create_task(client.connect(**kwargs))
    deadline = time.monotonic() + CONNECT_TIMEOUT_SECONDS
    try:
        while not task.done():
            if _stop_event.is_set():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise _WorkerStopping()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise TimeoutError("realtime connect timed out")
            await asyncio.wait({task}, timeout=min(0.05, remaining))
        try:
            task.result()
        except Exception as exc:
            if bool(getattr(getattr(client, "auth", None), "auth_retry_requested", False)):
                raise _AuthRefreshRequired() from exc
            raise
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def _close_unowned_client(client: Any) -> None:
    try:
        await asyncio.wait_for(client.close(), timeout=CLOSE_TIMEOUT_SECONDS)
    except Exception:
        # Preserve the original connect failure/cancellation over cleanup.
        pass


async def _sync_session(session: _Session, desired: dict[tuple[str, ...], dict[str, str]]) -> None:
    if session.client is None:
        return
    wanted = set(desired)
    removed = session.registered - wanted
    if removed:
        identities = [session.registered_identities[key] for key in sorted(removed) if key in session.registered_identities]
        if identities:
            for packet in _remove_packets(session.market, identities):
                await session.client.send(packet)
        session.registered -= removed
        for key in removed:
            session.registered_identities.pop(key, None)
    added = wanted - session.registered
    if added:
        identities = [desired[key] for key in sorted(added)]
        for packet in _registration_packets(session.market, identities):
            await session.client.send(packet)
        session.registered |= added
        session.registered_identities.update({key: dict(identity) for key, identity in zip(sorted(added), identities)})


def _subscription_items(market: str, identities: list[dict[str, str]]) -> list[Any]:
    return [identity["stkCd"] for identity in identities] if market == "KR" else [
        {"jmcode": identity["stkCd"], "stex_tp": identity["stexTp"]} for identity in identities
    ]


def _registration_packets(market: str, identities: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Keep each type in the single-type shape used by official examples."""
    items = _subscription_items(market, identities)
    return [_sdk_build_reg_packet(items, [event_type], group_no="1", refresh="1") for event_type in _TYPES[market]]


def _remove_packets(market: str, identities: list[dict[str, str]]) -> list[dict[str, Any]]:
    items = _subscription_items(market, identities)
    return [_sdk_build_remove_packet(items, [event_type], group_no="1") for event_type in _TYPES[market]]


async def _receive_once(session: _Session) -> None:
    if session.client is None or (not session.registered and not _condition_has_work(session.market)):
        return
    try:
        message = await asyncio.wait_for(session.client.recv(), timeout=0.05)
    except TimeoutError:
        return
    if _handle_condition_message(session, message):
        return
    for event in _normalized_events(message):
        _handle_event(session, event)


def _condition_failed(session: _Session, command: _ConditionCommand, error: Exception) -> None:
    with _lock:
        if _condition_inflight[session.market] is command:
            _condition_inflight[session.market] = None
            if _condition_command_owner_matches_locked(command):
                _condition_reset_requested.add(session.market)
        _finish_condition_locked(command, error=error)


def _record_condition_live_events(market: str, message: Any) -> bool:
    """Append documented condition membership REAL frames to active state only."""
    if not isinstance(message, dict) or str(message.get("trnm") or "") != "REAL":
        return False
    data = message.get("data")
    if not isinstance(data, list) or not any(isinstance(entry, dict) and isinstance(entry.get("values"), dict) and "841" in entry["values"] for entry in data):
        return False
    try:
        events = condition_search.parse_live_membership_events(market, message)
    except condition_search.ConditionSearchError:
        # This is a condition-shaped frame, so do not pass it to quote parsing.
        return True
    now = _utc_now()
    with _lock:
        for event in events:
            state = _condition_live.get((market, event["seq"]))
            if state is None or state.get("state") != "active":
                continue
            sequence = int(state.get("sequence") or 0) + 1
            state["sequence"] = sequence
            state["updatedAt"] = now
            state["note"] = "Receiving documented saved-condition membership events."
            stored = {**event, "sequence": sequence, "sequenceSemantics": "local process arrival order; not provider or exchange order", "receivedAt": now}
            state["events"].append(stored)
    return True


def _handle_condition_message(session: _Session, message: Any) -> bool:
    """Consume only the one serialized condition reply for this market."""
    if not isinstance(message, dict):
        return False
    if _record_condition_live_events(session.market, message):
        return True
    with _lock:
        command = _condition_inflight[session.market]
    if command is None:
        return False
    if str(message.get("trnm") or "") != command.spec.response_trnm:
        return False
    try:
        if command.spec.operation == "list":
            result = condition_search.parse_list_response(session.market, message)
        elif command.spec.operation == "unsubscribe":
            result = condition_search.parse_unsubscribe_response(session.market, command.spec, message)
        else:
            page = condition_search.parse_result_page(session.market, command.spec, message)
            command.pages.append(page)
            if page["hasNext"] and command.spec.operation == "result" and len(command.pages) < CONDITION_MAX_PAGES:
                command.packet = condition_search.build_command(
                    session.market,
                    "result",
                    seq=command.spec.seq,
                    cont_yn="Y",
                    next_key=page["nextKey"],
                ).packet
                command.awaiting_response = False
                return True
            result = condition_search.combine_result_pages(
                command.spec,
                command.pages,
                complete=not page["hasNext"],
                note="pagination capped at 5 pages" if page["hasNext"] else "",
            )
            if command.spec.realtime:
                result["live"] = {
                    "state": "active",
                    "activation": "explicit",
                    "registrationId": command.registration_id,
                }
    except condition_search.ConditionSearchError as exc:
        _condition_failed(session, command, exc)
        return True
    with _lock:
        if _condition_inflight[session.market] is not command:
            return True
        if not _condition_command_owner_matches_locked(command):
            _condition_inflight[session.market] = None
            _finish_condition_locked(command, error=condition_search.ConditionSearchError("saved condition registration ownership changed"))
            return True
        _condition_inflight[session.market] = None
        if command.spec.realtime:
            key = (session.market, command.spec.seq or "")
            reservation = _condition_live.get(key)
            if reservation is None or reservation.get("state") != "pending" or reservation.get("registrationId") != command.registration_id:
                _finish_condition_locked(command, error=condition_search.ConditionSearchError("saved-condition live reservation was lost"))
                return True
            if len(_condition_live) > CONDITION_STATE_LIMIT:
                _finish_condition_locked(command, error=condition_search.ConditionSearchError("saved-condition state limit reached"))
                return True
            reservation.update({"registeredAt": _utc_now(), "updatedAt": _utc_now(), "state": "active", "reason": None, "note": "Live membership registration acknowledged; awaiting documented membership events."})
        elif command.spec.operation == "unsubscribe":
            state = _condition_live.get((session.market, command.spec.seq or ""))
            if state is not None and state.get("registrationId") == command.registration_id:
                state.update({"state": "inactive", "reason": None, "updatedAt": _utc_now(), "note": "Live membership registration was explicitly cleared."})
        _finish_condition_locked(command, result=result)
    return True


def _normalized_events(message: Any) -> list[dict[str, Any]]:
    """Use the SDK normalizer while retaining the official US exchange field."""
    events = _sdk_normalize_message_events(message, _COLUMNS)
    if not isinstance(message, dict) or str(message.get("trnm") or "").upper() != "REAL":
        return events
    raw_entries = [entry for entry in message.get("data", []) if isinstance(entry, dict)] if isinstance(message.get("data"), list) else []
    for event, raw in zip(events, raw_entries):
        venue = raw.get("stexTp") or raw.get("stex_tp")
        if venue not in (None, ""):
            event["_stexTp"] = str(venue).strip().upper()
    return events


def _handle_event(session: _Session, event: dict[str, Any]) -> None:
    trnm = str(event.get("trnm") or "").upper()
    if trnm == "REG":
        code = event.get("return_code")
        if code not in (None, 0, "0"):
            _registration_failed(session.market)
        return
    if trnm != "REAL":
        return
    # Event type is protocol data: do not fold case because official realtime
    # IDs include case-distinct values outside the current public feed set.
    event_type = str(event.get("type") or "")
    if event_type not in _TYPES[session.market]:
        return
    key = _event_key(session.market, event)
    if key is None:
        return
    if event_type in {"0B", "FE"}:
        accepted = _apply_trade(key, event)
    else:
        accepted = _apply_book(key, event)
    if accepted:
        session.retry_delay = RETRY_INITIAL_SECONDS
        session.next_retry_at = 0.0


def _event_key(market: str, event: dict[str, Any]) -> tuple[str, ...] | None:
    item = event.get("item")
    code = item.get("jmcode") if isinstance(item, dict) else item
    code = str(code or "").strip().upper()
    if not code:
        return None
    venue = str(event.get("_stexTp") or "").strip().upper()
    with _lock:
        candidates = [key for key, instrument in _instruments.items() if instrument.identity["market"] == market and instrument.identity["stkCd"] == code]
        if market == "US" and venue:
            candidates = [key for key in candidates if _instruments[key].identity["stexTp"] == venue]
        # A venue-free US event can be routed only if its active identity is
        # still unique.  This never guesses among same-code listings.
        return candidates[0] if len(candidates) == 1 else None


def _number(value: Any, *, absolute: bool = False, price: bool = False) -> float | None:
    if value is None or str(value).strip() in {"", "-"}:
        return None
    try:
        number = float(Decimal(str(value).strip().replace(",", "")))
    except (InvalidOperation, ValueError):
        return None
    if not math.isfinite(number) or (price and number == 0):
        return None
    return abs(number) if absolute else number


def _raw_time_value(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text[:32] or None


def _source_time_metadata(event: dict[str, Any]) -> dict[str, Any] | None:
    """Preserve documented raw fields without manufacturing a timestamp.

    KR 0B exposes only an HHmmss field.  FE exposes date and local-time
    fields, but the SDK specification does not establish their common market
    calendar or timezone.  Neither case is safe to turn into an ISO instant.
    """
    trade_time = _raw_time_value(event.get("tradeTime"))
    trade_date = _raw_time_value(event.get("tradeDate"))
    local_trade_time = _raw_time_value(event.get("localTradeTime"))
    if trade_time is None and trade_date is None and local_trade_time is None:
        return None
    second_precision = any(re.fullmatch(r"[0-9]{6}", value or "") for value in (trade_time, local_trade_time))
    date_precision = "day" if re.fullmatch(r"[0-9]{8}", trade_date or "") else "unavailable" if trade_date is None else "unknown"
    return {
        "rawTradeTime": trade_time,
        "rawTradeDate": trade_date,
        "rawLocalTradeTime": local_trade_time,
        "precision": "second" if second_precision else "unknown",
        "datePrecision": date_precision,
        "timezone": "unverified",
        "timestamp": None,
        "timestampStatus": "not-derived: provider calendar/timezone relationship is unverified",
    }


def _receipt_minute_start(received_at: str) -> str:
    parsed = datetime.fromisoformat(received_at.replace("Z", "+00:00"))
    return parsed.replace(second=0, microsecond=0).isoformat().replace("+00:00", "Z")


def _update_observed_ohlc(snapshot: dict[str, Any], price: float, received_at: str, sequence: int) -> dict[str, Any]:
    """Aggregate local arrival observations; this is not an exchange-time bar."""
    observed = snapshot.get("observedOhlc")
    if not isinstance(observed, dict):
        observed = {
            "basis": "local arrival-order price observations",
            "open": price,
            "high": price,
            "low": price,
            "close": price,
            "count": 1,
            "firstReceivedAt": received_at,
            "lastReceivedAt": received_at,
            "sourceTimestamp": None,
            "complete": False,
            "note": "Observed since subscription; not an exchange-time OHLC candle.",
        }
    else:
        observed = dict(observed)
        observed["high"] = max(float(observed["high"]), price)
        observed["low"] = min(float(observed["low"]), price)
        observed["close"] = price
        observed["count"] = int(observed["count"]) + 1
        observed["lastReceivedAt"] = received_at
    snapshot["observedOhlc"] = observed
    bucket_start = _receipt_minute_start(received_at)
    minute = snapshot.get("observedMinute")
    if not isinstance(minute, dict) or minute.get("bucketStart") != bucket_start:
        minute = {
            "basis": "receipt-time observations",
            "bucketStart": bucket_start,
            "open": price,
            "high": price,
            "low": price,
            "close": price,
            "count": 1,
            "firstSequence": sequence,
            "lastSequence": sequence,
            "complete": False,
            "note": "Local receipt-minute observations; not an exchange-time OHLC candle.",
        }
    else:
        minute = dict(minute)
        minute["high"] = max(float(minute["high"]), price)
        minute["low"] = min(float(minute["low"]), price)
        minute["close"] = price
        minute["count"] = int(minute["count"]) + 1
        minute["lastSequence"] = sequence
    snapshot["observedMinute"] = minute
    return observed


def _append_event(instrument: _Instrument, *, kind: str, event_type: str, received_at: str, source_time: dict[str, Any] | None, values: dict[str, Any]) -> dict[str, Any]:
    sequence = int(instrument.snapshot.get("_arrivalSequence") or 0) + 1
    instrument.snapshot["_arrivalSequence"] = sequence
    entry = {
        "sequence": sequence,
        "sequenceSemantics": "local process arrival order; not provider or exchange order",
        "kind": kind,
        "eventType": event_type,
        "receivedAt": received_at,
        "sourceTime": deepcopy(source_time),
        "connectionEpoch": int(instrument.snapshot.get("_connectionEpoch") or 0),
        **deepcopy(values),
    }
    pending_gap = instrument.snapshot.pop("_pendingJournalGap", None)
    if pending_gap is not None:
        entry["gapBefore"] = deepcopy(pending_gap)
    instrument.events.append(entry)
    return entry


def _apply_trade(key: tuple[str, ...], event: dict[str, Any]) -> bool:
    now_iso, now_mono = _utc_now(), _monotonic()
    parsed = {
        "last": _number(event.get("last"), absolute=True, price=True),
        "change": _number(event.get("change")),
        "changePct": _number(event.get("changePct")),
        "volume": _number(event.get("volume"), absolute=True),
    }
    # A REAL envelope with none of the documented trade values is malformed;
    # it must not refresh data freshness or claim the subscription is live.
    if not any(value is not None for value in parsed.values()):
        return False
    source_time = _source_time_metadata(event)
    has_price = parsed["last"] is not None
    has_volume = parsed["volume"] is not None
    with _lock:
        instrument = _instruments.get(key)
        if instrument is None:
            return False
        snapshot = instrument.snapshot
        for field, value in parsed.items():
            if value is not None:
                snapshot[field] = value
        snapshot.update({
            "receivedAt": now_iso,
            "tradeSourceTime": source_time,
            "sourceTimestamp": None,
            "status": "live",
            "bookLive": bool(snapshot.get("_bookMonotonic")),
            "note": "Broker trade price event; source timestamp was not derived." if has_price else "Broker volume/change event; price freshness was not refreshed.",
        })
        if has_price:
            snapshot.update({"priceReceivedAt": now_iso, "tradeReceivedAt": now_iso, "_tradeMonotonic": now_mono})
            observed = _update_observed_ohlc(snapshot, parsed["last"], now_iso, int(snapshot.get("_arrivalSequence") or 0) + 1)
        else:
            observed = snapshot.get("observedOhlc")
        if has_volume:
            snapshot.update({"volumeReceivedAt": now_iso, "_volumeMonotonic": now_mono})
        _append_event(
            instrument,
            kind="trade",
            event_type=str(event.get("type") or ""),
            received_at=now_iso,
            source_time=source_time,
            values={**parsed, "observedOhlc": observed},
        )
    return True


def _levels(event: dict[str, Any]) -> tuple[list[dict[str, float | None]], list[dict[str, float | None]]]:
    asks: list[dict[str, float | None]] = []
    bids: list[dict[str, float | None]] = []
    for level in range(10, 0, -1):
        price = _number(event.get(f"ask{level}"), absolute=True, price=True)
        if price is not None:
            asks.append({"price": price, "qty": _number(event.get(f"ask{level}qty"), absolute=True)})
    for level in range(1, 11):
        price = _number(event.get(f"bid{level}"), absolute=True, price=True)
        if price is not None:
            bids.append({"price": price, "qty": _number(event.get(f"bid{level}qty"), absolute=True)})
    return asks, bids


def _apply_book(key: tuple[str, ...], event: dict[str, Any]) -> bool:
    asks, bids = _levels(event)
    # No documented empty-book sentinel exists.  Missing/zero prices remain
    # absent rather than being turned into a fabricated level or live update.
    if not asks and not bids:
        return False
    now_iso, now_mono = _utc_now(), _monotonic()
    source_time = _source_time_metadata(event)
    with _lock:
        instrument = _instruments.get(key)
        if instrument is None:
            return False
        instrument.snapshot.update({
            "asks": asks,
            "bids": bids,
            "receivedAt": now_iso,
            "bookReceivedAt": now_iso,
            "bookSourceTime": source_time,
            "sourceTimestamp": None,
            "status": "live",
            "bookLive": True,
            "note": "Broker order-book event; source timestamp is not unambiguous.",
            "_bookMonotonic": now_mono,
        })
        _append_event(
            instrument,
            kind="book",
            event_type=str(event.get("type") or ""),
            received_at=now_iso,
            source_time=source_time,
            values={"asks": asks, "bids": bids},
        )
    return True


def _registration_failed(market: str) -> None:
    _set_market_state(market, "error", "Broker rejected registration.")
    with _lock:
        for instrument in _instruments.values():
            if instrument.identity["market"] == market and not (instrument.snapshot.get("_tradeMonotonic") or instrument.snapshot.get("_bookMonotonic")):
                instrument.snapshot.update({"status": "subscription-error", "bookLive": False, "note": "Broker rejected registration."})


async def _session_failed(session: _Session, message: str) -> None:
    await _close_session(session, remove=False)
    with _lock:
        _cancel_market_conditions_locked(session.market, "saved-condition request canceled by realtime reconnect")
    delay = max(RETRY_INITIAL_SECONDS, session.retry_delay)
    session.next_retry_at = _monotonic() + delay
    session.retry_delay = min(RETRY_MAX_SECONDS, delay * 2.0)
    _set_market_state(session.market, "error", message)
    _mark_market_stale(session.market, message)


def _mark_market_stale(market: str, message: str) -> None:
    with _lock:
        for instrument in _instruments.values():
            if instrument.identity["market"] != market:
                continue
            has_data = bool(instrument.snapshot.get("_tradeMonotonic") or instrument.snapshot.get("_volumeMonotonic") or instrument.snapshot.get("_bookMonotonic"))
            sequence = int(instrument.snapshot.get("_arrivalSequence") or 0)
            if sequence:
                epoch = int(instrument.snapshot.get("_connectionEpoch") or 0) + 1
                gap = {
                    "reason": "transport reconnect or failure",
                    "afterSequence": sequence,
                    "detectedAt": _utc_now(),
                    "sequenceSemantics": "local process arrival order; not provider or exchange order",
                }
                instrument.snapshot.update({"_connectionEpoch": epoch, "_pendingJournalGap": gap, "eventJournalGap": gap})
            instrument.snapshot.update({
                "status": "stale" if has_data else "subscription-error",
                "bookLive": False,
                "note": message,
            })


def _set_market_state(market: str, state: str, error: str) -> None:
    with _lock:
        _market_state[market] = {"state": state, "error": error}


async def _close_session(session: _Session, *, remove: bool) -> None:
    client, registered = session.client, set(session.registered)
    session.client = None
    session.registered.clear()
    registered_identities = dict(session.registered_identities)
    session.registered_identities.clear()
    if client is None:
        return
    if remove and registered:
        identities = [registered_identities[key] for key in sorted(registered) if key in registered_identities]
        if identities:
            try:
                for packet in _remove_packets(session.market, identities):
                    await client.send(packet)
            except Exception:
                pass
    try:
        await asyncio.wait_for(client.close(), timeout=CLOSE_TIMEOUT_SECONDS)
    except Exception:
        pass


def _sdk_get_ws_client(token: str | None = None) -> Any:
    """Official SDK client through the gateway's shared managed auth."""
    return gateway.ws_client_for_token(token) if token is not None else gateway.ws_client()


def _sdk_normalize_message_events(message: Any, columns: dict[str, str]) -> list[dict[str, Any]]:
    """Direct official SDK normalizer, kept injectable for transport-free tests."""
    from kiwoom.realtime.events import normalize_message_events

    return normalize_message_events(message, columns)
