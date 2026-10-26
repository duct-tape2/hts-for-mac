"""HTTP surface for the local read-only KR/US market viewer."""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import sys
import time
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator

from app import market_stream, kiwoom_gateway, market_analytics, company_credentials, condition_routes
from app.config import ENVIRONMENT, KIWOOM_ENABLED
from app.credentials import CredentialError, credential_manager
from app.store import store
from app.capture_routes import router as capture_router
from app.analysis_routes import router as analysis_router


ROOT = Path(__file__).resolve().parents[2]
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip() if (ROOT / "VERSION").exists() else "0.22"
UI_ORIGIN = "http://127.0.0.1:3010"
_LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost"})
_LOCAL_ORIGINS = {"http://127.0.0.1:3010", "http://localhost:3010", "http://127.0.0.1:8010", "http://localhost:8010"}
_SETUP_TOKEN = secrets.token_urlsafe(32)
_AUTH_BODY_LIMIT = 2048
_TRANSFER_BODY_LIMIT = 1_048_576
_STREAM_LEASE_SECONDS = 30.0
_STREAM_LEASE_REFRESH_GRACE_SECONDS = 30.0

credential_manager.set_generation_listener(market_stream.auth_generation_changed)


def _test_runtime() -> bool:
    """Keep Starlette's synthetic host out of production request policy."""
    return "pytest" in sys.modules or bool(os.environ.get("PYTEST_CURRENT_TEST"))


def _is_local_host(host: str) -> bool:
    return host in _LOCAL_HOSTS or (host == "testserver" and _test_runtime())


def _is_local_origin(origin: str) -> bool:
    parsed = urlparse(origin)
    canonical = f"{parsed.scheme}://{parsed.netloc}".lower()
    return (
        parsed.path in {"", "/"}
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
        and canonical in _LOCAL_ORIGINS
    )


def _local_api_read_allowed(request: Request) -> bool:
    """Allow local UI/CLI reads; reject browser navigation from another site.

    CORS controls response visibility, not whether a hostile page can cause a
    loopback GET.  Browser requests must therefore have a local Origin (when
    present) and same-site Fetch Metadata.  A loopback CLI has neither header
    and remains an explicitly supported local operator path.
    """
    if not _is_local_host((request.url.hostname or "").lower()):
        return False
    origin = request.headers.get("origin")
    if origin and not _is_local_origin(origin):
        return False
    return request.headers.get("sec-fetch-site", "").lower() in {"", "same-origin", "same-site"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Keychain/FileTokenStore work is synchronous; fixture mode performs no
    # Keychain or broker call, even when TestClient enters this lifespan.
    if KIWOOM_ENABLED:
        await asyncio.to_thread(credential_manager.start)
    market_stream.start()
    yield
    market_stream.stop()
    if KIWOOM_ENABLED:
        await asyncio.to_thread(credential_manager.stop)


app = FastAPI(title="HTS for Mac 조회 전용 시장 API", version=VERSION, lifespan=lifespan)
app.include_router(capture_router)
app.include_router(analysis_router)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=[*_LOCAL_HOSTS, *( ["testserver"] if _test_runtime() else [])])
app.add_middleware(CORSMiddleware, allow_origins=sorted(_LOCAL_ORIGINS), allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type", "X-HTS-Setup"], allow_credentials=False)


@app.middleware("http")
async def local_api_boundary(request: Request, call_next):
    """Reject non-local or cross-site `/api` requests before any route work."""
    if request.url.path.startswith("/api/") and not _local_api_read_allowed(request):
        return JSONResponse(
            {"detail": "local API request required"},
            status_code=403,
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )
    return await call_next(request)


class WatchlistCreate(BaseModel):
    name: str


class ItemCreate(BaseModel):
    market: str
    stkCd: str
    stkNm: str = ""
    stexTp: str | None = None
    listingVenue: str | None = None
    quoteVenue: str | None = None
    currency: str | None = None
    environment: str | None = None
    enabled: bool = True
    last: float | None = None
    prevClose: float | None = None
    open: float | None = None
    changePct: float | None = None


class LocalTransferInstrument(BaseModel):
    """The only item shape accepted from a portable workspace transfer."""

    model_config = ConfigDict(extra="forbid", strict=True)
    market: Literal["KR", "US"]
    stkCd: str = Field(min_length=1, max_length=15)
    stkNm: str = Field(min_length=1, max_length=120)
    stexTp: Literal["KRX", "ND", "NY", "NA"]
    listingVenue: Literal["KOSPI", "KOSDAQ", "NASDAQ", "NYSE", "AMEX"]
    quoteVenue: Literal["KRX", "ND", "NY", "NA"]
    currency: Literal["KRW", "USD"]


class LocalTransferGroup(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=80)
    instruments: list[LocalTransferInstrument] = Field(max_length=250)

    @field_validator("name")
    @classmethod
    def _transfer_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("invalid")
        return value


class LocalWatchlistTransfer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    watchlists: list[LocalTransferGroup] = Field(max_length=64)


class CredentialRegistration(BaseModel):
    """Strict inbound shape whose errors never echo SecretStr input."""

    model_config = ConfigDict(extra="forbid", strict=True)
    appKey: SecretStr
    appSecret: SecretStr
    registeredExpiresOn: str

    @field_validator("appKey", "appSecret")
    @classmethod
    def _credential_text(cls, value: SecretStr) -> SecretStr:
        text = value.get_secret_value()
        if not 8 <= len(text) <= 256 or text != text.strip() or any(ord(char) < 33 or ord(char) == 127 for char in text):
            raise ValueError("invalid")
        return value

    @field_validator("registeredExpiresOn")
    @classmethod
    def _registered_date(cls, value: str) -> str:
        if len(value) != 10:
            raise ValueError("invalid")
        try:
            date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("invalid") from exc
        return value


class LauncherCredentialRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    registeredExpiresOn: str

    @field_validator("registeredExpiresOn")
    @classmethod
    def _registered_date(cls, value: str) -> str:
        if len(value) != 10:
            raise ValueError("invalid")
        try:
            date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("invalid") from exc
        return value


def _local_mutation(request: Request) -> None:
    host = (request.url.hostname or "").lower()
    if not _is_local_host(host):
        raise HTTPException(403, "local host required")
    origin = request.headers.get("origin")
    if not origin:
        return
    if not _is_local_origin(origin):
        raise HTTPException(403, "local origin required")


def _auth_denied() -> HTTPException:
    return HTTPException(403, "local authorization required", headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


def _credential_error(detail: str = "Invalid credential request.") -> HTTPException:
    return HTTPException(400, detail, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


def _auth_request(request: Request, *, mutation: bool) -> None:
    """Require local Fetch Metadata and a per-process write capability."""
    if not _is_local_host((request.url.hostname or "").lower()):
        raise _auth_denied()
    if request.headers.get("sec-fetch-site", "").lower() not in {"same-origin", "same-site"}:
        raise _auth_denied()
    origin = request.headers.get("origin")
    if mutation and not origin:
        raise _auth_denied()
    if origin and not _is_local_origin(origin):
        raise _auth_denied()
    # Browser same-origin GET fetches normally omit Origin. Local host plus
    # same-site Fetch Metadata is permitted only for this read setup step.
    if mutation:
        try:
            capability_matches = hmac.compare_digest(
                request.headers.get("x-hts-setup", "").encode("ascii"),
                _SETUP_TOKEN.encode("ascii"),
            )
        except UnicodeEncodeError:
            capability_matches = False
        if not capability_matches:
            raise _auth_denied()


company_credentials.configure_auth_guard(_auth_request)
app.include_router(company_credentials.router)
condition_routes.configure_auth_guard(_auth_request)
app.include_router(condition_routes.router)


def _no_store(payload: dict) -> JSONResponse:
    return JSONResponse(payload, headers={"Cache-Control": "no-store", "Pragma": "no-cache", "Vary": "Origin"})


async def _credential_body(request: Request, model: type[BaseModel] = CredentialRegistration):
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) < 0 or int(length) > _AUTH_BODY_LIMIT:
                raise ValueError
        except ValueError:
            raise _credential_error() from None
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > _AUTH_BODY_LIMIT:
            raise _credential_error()
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw:
        raise _credential_error()
    try:
        return model.model_validate_json(raw)
    except ValidationError:
        raise _credential_error() from None


async def _local_transfer_body(request: Request) -> LocalWatchlistTransfer:
    """Bound and validate the portable data before the store can mutate."""
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) < 0 or int(length) > _TRANSFER_BODY_LIMIT:
                raise ValueError
        except ValueError:
            raise HTTPException(413, "Workspace transfer is too large.") from None
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > _TRANSFER_BODY_LIMIT:
            raise HTTPException(413, "Workspace transfer is too large.")
        chunks.append(chunk)
    try:
        return LocalWatchlistTransfer.model_validate_json(b"".join(chunks))
    except ValidationError:
        raise HTTPException(400, "Invalid workspace transfer.") from None


def _state() -> dict:
    info = kiwoom_gateway.ping()
    return store.runtime_status(mode=ENVIRONMENT, connected=bool(info.get("connected")), error=str(info.get("error") or ""))


def _broker_error(exc: Exception) -> HTTPException:
    # Gateway failure messages are intentionally generic and token-safe.
    return HTTPException(502 if KIWOOM_ENABLED else 400, "market data request failed")


def _ui(path: str, request: Request) -> RedirectResponse:
    target = f"{UI_ORIGIN}{path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"
    return RedirectResponse(target)


@app.get("/")
def redirect_home(request: Request) -> RedirectResponse:
    return _ui("/", request)


@app.get("/watchlists")
def redirect_watchlists(request: Request) -> RedirectResponse:
    return _ui("/", request)


@app.get("/desk2")
def redirect_desk2(request: Request) -> RedirectResponse:
    return _ui("/", request)


@app.get("/api/health")
def health() -> dict:
    info = kiwoom_gateway.ping()
    _state()
    return {"ok": True, "version": VERSION, "mode": ENVIRONMENT, "kiwoom": "connected" if info.get("connected") else "disconnected", "error": str(info.get("error") or ""), "note": "Read-only market viewer. Order, account, and trade-history APIs are unavailable."}


@app.get("/api/auth/status")
def auth_status(request: Request) -> JSONResponse:
    _auth_request(request, mutation=False)
    return _no_store({**credential_manager.public_status(), "setupToken": _SETUP_TOKEN})


@app.post("/api/auth/credentials")
async def register_credentials(request: Request) -> JSONResponse:
    # This guard intentionally precedes body parsing, Keychain reads, SDK auth,
    # and all outbound I/O.
    _auth_request(request, mutation=True)
    body = await _credential_body(request)
    try:
        status = await asyncio.to_thread(
            credential_manager.register,
            app_key=body.appKey.get_secret_value(),
            app_secret=body.appSecret.get_secret_value(),
            registered_expires_on=date.fromisoformat(body.registeredExpiresOn),
        )
    except CredentialError:
        raise _credential_error("Credential registration failed.") from None
    except Exception:
        # SDK/provider text is never a local API error payload or traceback.
        raise _credential_error("Credential registration failed.") from None
    return _no_store({**status, "setupToken": _SETUP_TOKEN})


@app.post("/api/auth/credentials/from-launcher")
async def register_launcher_credentials(request: Request) -> JSONResponse:
    _auth_request(request, mutation=True)
    body = await _credential_body(request, LauncherCredentialRegistration)
    try:
        status = await asyncio.to_thread(
            credential_manager.register_from_launcher,
            registered_expires_on=date.fromisoformat(body.registeredExpiresOn),
        )
    except Exception:
        raise _credential_error("Credential registration failed.") from None
    return _no_store({**status, "setupToken": _SETUP_TOKEN})


@app.get("/api/state")
def get_state() -> dict:
    return _state()


@app.get("/api/watchlists")
def list_watchlists() -> dict:
    state = _state()
    return {"watchlists": state["watchlists"], "items": state["items"]}


@app.post("/api/watchlists")
def create_watchlist(body: WatchlistCreate, request: Request) -> dict:
    _local_mutation(request)
    try:
        store.add_watchlist(body.name)
        return _state()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/watchlists/{watchlist_id}")
def delete_watchlist(watchlist_id: str, request: Request) -> dict:
    _local_mutation(request)
    store.remove_watchlist(watchlist_id)
    return _state()


@app.post("/api/watchlists/{watchlist_id}/items")
def add_item(watchlist_id: str, body: ItemCreate, request: Request) -> dict:
    _local_mutation(request)
    try:
        store.add_item(watchlist_id, body.model_dump())
        return _state()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/watchlists/{watchlist_id}/items/{item_id}")
def delete_item(watchlist_id: str, item_id: str, request: Request) -> dict:
    _local_mutation(request)
    store.remove_item(watchlist_id, item_id)
    return _state()


@app.post("/api/watchlists/{watchlist_id}/items/{item_id}/toggle")
def toggle_item(watchlist_id: str, item_id: str, request: Request) -> dict:
    _local_mutation(request)
    store.toggle_item(watchlist_id, item_id)
    return _state()


@app.post("/api/watchlists/import-local")
async def import_local_watchlists(request: Request) -> dict:
    # This endpoint does not contact Kiwoom or any other broker.  Its small,
    # strict body excludes credentials, quote values, ids, and environment.
    _local_mutation(request)
    body = await _local_transfer_body(request)
    try:
        store.import_local_watchlists([group.model_dump() for group in body.watchlists])
        return _state()
    except ValueError:
        raise HTTPException(400, "Invalid workspace transfer.") from None
    except OSError:
        raise HTTPException(500, "Could not save workspace transfer.") from None


@app.post("/api/watchlists/{watchlist_id}/import-kiwoom")
def import_kiwoom(watchlist_id: str, request: Request, market: str = "US") -> dict:
    _local_mutation(request)
    try:
        groups = kiwoom_gateway.get_hts_watchlists() if market == "US" else kiwoom_gateway.get_hts_watchlists(market)
        store.import_kiwoom(watchlist_id, groups)
        return _state()
    except Exception as exc:
        raise _broker_error(exc) from exc


@app.post("/api/watchlists/{watchlist_id}/save")
def save_watchlist(watchlist_id: str, request: Request) -> dict:
    _local_mutation(request)
    _ = watchlist_id  # Saves app-local v2 file only; no upstream write exists.
    store.save()
    return _state()


@app.get("/api/symbols/search")
def search_symbols(q: str = "", market: str | None = None) -> dict:
    try:
        return kiwoom_gateway.search_symbols(q, market)
    except Exception as exc:
        raise _broker_error(exc) from exc


def _quote(*, stk_cd: str, stex_tp: str | None, market: str, listing_venue: str | None, book: bool) -> dict:
    quote = kiwoom_gateway.get_quote(market=market, stk_cd=stk_cd, stex_tp=stex_tp, listing_venue=listing_venue, book=book)
    return kiwoom_gateway.merge_stream(quote, market_stream.snapshot(quote)) if KIWOOM_ENABLED else quote


@app.get("/api/quotes")
def get_quote(stk_cd: str, stex_tp: str | None = None, market: str = "US", listing_venue: str | None = None, lite: bool = False) -> dict:
    try:
        return _quote(stk_cd=stk_cd, stex_tp=stex_tp, market=market, listing_venue=listing_venue, book=not lite)
    except Exception as exc:
        raise _broker_error(exc) from exc


@app.get("/api/quotes/live")
def live_quote(stk_cd: str, stex_tp: str | None = None, market: str = "US", listing_venue: str | None = None) -> dict:
    return get_quote(stk_cd, stex_tp, market, listing_venue)


class MarketStreamRequest(BaseModel):
    instruments: list[ItemCreate] = Field(min_length=1, max_length=200)


def _stream_identity(item: ItemCreate) -> dict:
    identity = kiwoom_gateway._identity(market=item.market, stk_cd=item.stkCd, stex_tp=item.stexTp, listing_venue=item.listingVenue)
    for key in ("environment", "quoteVenue", "currency"):
        supplied = getattr(item, key)
        if supplied is not None and supplied != identity[key]:
            raise kiwoom_gateway.BrokerError("stream identity does not match the runtime")
    return {**identity, "stkNm": item.stkNm or identity["stkCd"]}


def _event(value: dict, event: str = "quote") -> str:
    return f"event: {event}\ndata: {json.dumps(value, ensure_ascii=False, allow_nan=False)}\n\n"


def _stream_lease_seconds(identity_count: int) -> float:
    """Allow the bounded two-at-a-time initial refresh before rotating SSE."""
    return max(
        _STREAM_LEASE_SECONDS,
        identity_count * 1.2 + _STREAM_LEASE_REFRESH_GRACE_SECONDS,
    )


async def _market_events(identities: list[dict], request: Request, *, lease_seconds: float | None = None):
    """Multiplex one bounded local stream; release every upstream ref on exit."""
    subscriptions, tasks = [], set()
    quotes: dict[int, dict] = {}
    failures: dict[int, str] = {}
    sent: dict[int, str] = {}
    next_refresh: dict[int, float] = {}
    in_flight: set[int] = set()
    snapshot_only: set[int] = set()
    semaphore = asyncio.Semaphore(2)
    # Reserve REST capacity for charts and searching. Actual live frames do
    # not require REST refreshes, and gateway shares concurrent reads.
    refresh_seconds = max(30.0, len(identities) * 1.2)
    lease_deadline = time.monotonic() + (
        lease_seconds if lease_seconds is not None else _stream_lease_seconds(len(identities))
    )

    async def refresh(index: int):
        identity = identities[index]
        try:
            async with semaphore:
                quotes[index] = await asyncio.to_thread(kiwoom_gateway.get_quote, market=identity["market"], stk_cd=identity["stkCd"], stex_tp=identity["stexTp"], listing_venue=identity["listingVenue"], book=True)
                failures.pop(index, None)
        except asyncio.CancelledError:
            raise
        except Exception:
            failures[index] = "Market data unavailable; retrying without fixture fallback."
        finally:
            in_flight.discard(index)
            next_refresh[index] = time.monotonic() + refresh_seconds

    try:
        if KIWOOM_ENABLED:
            for index, identity in enumerate(identities):
                try:
                    subscriptions.append(market_stream.subscribe(identity))
                except market_stream.SubscriptionError:
                    snapshot_only.add(index)
        yield ": connected\n\n"
        heartbeat_at = time.monotonic()
        while not await request.is_disconnected():
            now = time.monotonic()
            if now >= lease_deadline:
                # The client opens a new multiplexed stream after this event.
                # A lease prevents legacy/background tabs from permanently
                # occupying browser HTTP/1 connection slots.
                yield _event({"retryAfterMs": 1_000}, "stream-retry")
                break
            for index, identity in enumerate(identities):
                if index not in in_flight and now >= next_refresh.get(index, 0):
                    in_flight.add(index)
                    task = asyncio.create_task(refresh(index))
                    tasks.add(task)
                    task.add_done_callback(tasks.discard)
                quote = quotes.get(index)
                stream = market_stream.snapshot(identity) if KIWOOM_ENABLED else None
                if quote is None and stream and stream.get("receivedAt"):
                    quote = kiwoom_gateway._base_quote(identity, name=identity["stkNm"], source="kiwoom")
                    quote.update({"receivedAt": None, "tradeReceivedAt": None, "status": "missing"})
                if quote:
                    current = kiwoom_gateway.merge_stream(quote, stream)
                    if index in snapshot_only:
                        current = {**current, "bookLive": False, "bookNote": "Realtime limit reached; periodic REST snapshot only."}
                    if index in failures and current.get("status") != "live":
                        current = {**current, "status": "stale", "note": failures[index]}
                    packet = _event(current)
                elif index in failures:
                    packet = _event({"identity": identity, "message": failures[index]}, "quote-error")
                else:
                    continue
                if sent.get(index) != packet:
                    sent[index] = packet
                    yield packet
            if now - heartbeat_at >= 10:
                heartbeat_at = now
                yield ": heartbeat\n\n"
            await asyncio.sleep(0.08)
    except market_stream.SubscriptionError:
        yield _event({"message": "Realtime subscription limit or identity rejected."}, "stream-error")
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for subscription in subscriptions:
            market_stream.unsubscribe(subscription)


def _stream_response(identities: list[dict], request: Request) -> StreamingResponse:
    return StreamingResponse(_market_events(identities, request), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no"})


@app.post("/api/market/stream")
async def market_quotes(body: MarketStreamRequest, request: Request):
    _local_mutation(request)
    try:
        unique = {}
        for item in body.instruments:
            identity = _stream_identity(item)
            unique[kiwoom_gateway._cache_key(identity, "stream")] = identity
    except kiwoom_gateway.BrokerError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _stream_response(list(unique.values()), request)


@app.get("/api/quotes/stream")
async def quote_stream(request: Request, stk_cd: str, stex_tp: str | None = None, market: str = "US", listing_venue: str | None = None):
    _local_mutation(request)
    try:
        identity = _stream_identity(ItemCreate(market=market, stkCd=stk_cd, stexTp=stex_tp, listingVenue=listing_venue))
    except kiwoom_gateway.BrokerError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _stream_response([identity], request)


@app.get("/api/market/events")
def market_events(stk_cd: str, market: Literal["KR", "US"], stex_tp: str | None = None,
                  listing_venue: str | None = None, after_sequence: int | None = None, limit: int = 256):
    try:
        identity = kiwoom_gateway._identity(market=market, stk_cd=stk_cd, stex_tp=stex_tp, listing_venue=listing_venue)
        payload = market_stream.event_journal(identity, after_sequence=after_sequence, limit=limit)
        return payload or {"identity": identity, "events": [], "oldestSequence": None, "latestSequence": 0,
            "gap": False, "truncated": False, "transportGap": None, "retention": 256,
            "sequenceSemantics": "local process arrival order; not provider or exchange order"}
    except (kiwoom_gateway.BrokerError, market_stream.SubscriptionError, ValueError) as exc:
        raise HTTPException(422, "종목 또는 관찰 기록 범위를 확인하세요.") from exc


@app.get("/api/market/status")
def market_status() -> dict:
    return market_stream.status()


@app.get("/api/market/rankings")
def market_rankings(kind: str = "gainers", market: str = "all") -> dict:
    try:
        return market_analytics.get_rankings(kind=kind, market=market)
    except Exception as exc:
        raise _broker_error(exc) from exc


@app.get("/api/market/investors")
def market_investors(stk_cd: str, listing_venue: str = "KOSPI") -> dict:
    try:
        return market_analytics.get_investor_flow(stk_cd=stk_cd, listing_venue=listing_venue)
    except market_analytics.IndexLoading as exc:
        raise HTTPException(409, "symbol index is loading") from exc
    except Exception as exc:
        raise _broker_error(exc) from exc


@app.get("/api/charts")
def get_chart(stk_cd: str, stex_tp: str | None = None, market: str = "US", listing_venue: str | None = None, interval: str = "D") -> dict:
    try:
        return kiwoom_gateway.get_chart(market=market, stk_cd=stk_cd, stex_tp=stex_tp, listing_venue=listing_venue, interval=interval)
    except Exception as exc:
        raise _broker_error(exc) from exc
