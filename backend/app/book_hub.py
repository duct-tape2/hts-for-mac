"""Deliberately single-symbol US FT hub for M0.

It is not a multi-watchlist stream. A later M1 registry must replace this
global selection model before claiming multi-symbol realtime support.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any

from app.config import KIWOOM_ENABLED, KIWOOM_MODE
from app.kiwoom_gateway import _number, assert_realtime_allowed, open_realtime, to_float


logger = logging.getLogger(__name__)
_lock = threading.Lock()
_wanted: dict[str, str] | None = None
_book: dict[str, Any] | None = None
_error = ""
_generation = 0
_thread: threading.Thread | None = None
_stop = threading.Event()

FT_COLUMNS = {
    **{str(40 + level): f"ask{level}" for level in range(1, 11)},
    **{str(60 + level): f"ask{level}qty" for level in range(1, 11)},
    **{str(50 + level): f"bid{level}" for level in range(1, 11)},
    **{str(70 + level): f"bid{level}qty" for level in range(1, 11)},
}


def watch(identity: dict) -> int:
    """Choose the only FT subscription; identity is never just a ticker."""
    global _wanted, _book, _generation
    required = ("environment", "market", "stkCd", "listingVenue", "quoteVenue")
    if identity.get("market") != "US" or any(identity.get(key) in (None, "") for key in required):
        return _generation
    wanted = {key: str(identity[key]) for key in required}
    wanted["stexTp"] = str(identity.get("stexTp") or identity["quoteVenue"])
    with _lock:
        if _wanted != wanted:
            _wanted, _book = wanted, None
            _generation += 1
        return _generation


def generation() -> int:
    with _lock:
        return _generation


def snapshot() -> dict[str, Any] | None:
    with _lock:
        return dict(_book) if _book else None


def last_error() -> str:
    with _lock:
        return _error


def start() -> None:
    global _thread
    if not KIWOOM_ENABLED or (_thread and _thread.is_alive()):
        return
    _stop.clear()
    _thread = threading.Thread(target=_run_loop, name="kiwoom-ft-single", daemon=True)
    _thread.start()


def stop() -> None:
    _stop.set()


def _run_loop() -> None:
    asyncio.run(_main())


def _same_symbol(event: dict, wanted: dict[str, str]) -> bool:
    item = event.get("item")
    raw = item.get("jmcode") if isinstance(item, dict) else item
    code = str(raw or event.get("stk_cd") or "").strip().upper()
    return bool(code) and code in {wanted["stkCd"], f"{wanted['stkCd']}{wanted['stexTp']}"}


def _levels(event: dict) -> tuple[list[dict], list[dict]]:
    source = {str(k): value for k, value in event.items()}
    if isinstance(event.get("values"), dict):
        source = {**{FT_COLUMNS.get(str(k), str(k)): value for k, value in event["values"].items()}, **source}
    asks, bids = [], []
    for level in range(10, 0, -1):
        price = abs(to_float(source.get(f"ask{level}")))
        if price:
            asks.append({"price": price, "qty": _number(source.get(f"ask{level}qty"), absolute=True)})
    for level in range(1, 11):
        price = abs(to_float(source.get(f"bid{level}")))
        if price:
            bids.append({"price": price, "qty": _number(source.get(f"bid{level}qty"), absolute=True)})
    return asks, bids


async def _main() -> None:
    global _error, _book
    client: Any = None
    current: dict[str, str] | None = None
    while not _stop.is_set():
        with _lock:
            wanted = dict(_wanted) if _wanted else None
        if not wanted:
            await asyncio.sleep(0.2)
            continue
        try:
            if client is None or not client.is_connected:
                if client is not None:
                    await client.close()
                # This happens before SDK construction/auth/connect.
                assert_realtime_allowed()
                from kiwoom import get_ws_client
                client = get_ws_client(KIWOOM_MODE)
                # The SDK accepts a connect factory; install the app-owned
                # exact-URL/no-proxy/no-redirect transport before connect.
                client._connect_factory = open_realtime
                await client.connect(api_url="/api/us/websocket")
                current = None
            if current != wanted:
                await client.send({"trnm": "REG", "grp_no": "1", "refresh": "0", "data": [{"item": [{"jmcode": wanted["stkCd"], "stex_tp": wanted["stexTp"]}], "type": ["FT"]}]})
                current = wanted
                with _lock:
                    _book, _error = None, ""
            try:
                message = await asyncio.wait_for(client.recv(), timeout=1.5)
            except TimeoutError:
                continue
            from kiwoom.realtime.events import normalize_message_events
            for event in normalize_message_events(message, FT_COLUMNS):
                if str(event.get("trnm") or "").upper() != "REAL" or str(event.get("type") or "FT").upper() != "FT" or not current or not _same_symbol(event, current):
                    continue
                asks, bids = _levels(event)
                if not asks and not bids:
                    continue
                with _lock:
                    if _wanted != current:
                        continue
                    _book = {**current, "asks": asks, "bids": bids, "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "monotonicAt": time.monotonic()}
        except Exception as exc:  # The HTTP layer receives only this bounded status.
            logger.warning("single FT hub failure: %s", type(exc).__name__)
            with _lock:
                _error = "US FT subscription unavailable"
            if client is not None:
                try:
                    await client.close()
                except Exception:
                    pass
            client, current = None, None
            await asyncio.sleep(2)
    if client is not None:
        await client.close()
