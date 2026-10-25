"""Read-only Kiwoom adapter.

Every SDK entry point is reached through ``_fetch_page``.  Its policy check
precedes SDK construction (and therefore token/auth/network activity), so the
application cannot be turned into a general Kiwoom proxy by request input.
"""
from __future__ import annotations

import re
import time
import math
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from decimal import Decimal, InvalidOperation
from functools import wraps
from threading import Lock, Thread
from typing import Any
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from app.config import ENVIRONMENT, KIWOOM_ENABLED, KIWOOM_MODE
from app.credentials import credential_manager


class BrokerError(RuntimeError):
    """A sanitized failure with an optional numeric provider diagnostic."""
    def __init__(self, message: str, *, provider_code: object = None):
        super().__init__(message)
        value = str(provider_code).strip()
        self.provider_code = value if re.fullmatch(r"-?\d{1,10}", value) else None


def read_failure_note(error: BrokerError) -> str:
    code = getattr(error, "provider_code", None)
    if code == "1504":
        return "키움이 이 API와 경로 조합을 지원하지 않는다고 응답했습니다(1504). 대체 가격은 표시하지 않습니다."
    if code:
        return f"키움 조회가 거절됐습니다(오류 {code}). 조회 조건과 API 지원 상태를 확인하세요."
    return "키움 조회를 완료하지 못했습니다. 연결 상태와 조회 조건을 확인하세요."


class RequestDenied(BrokerError):
    """Raised before authentication or outbound I/O."""


@dataclass(frozen=True)
class AllowedCall:
    api_id: str
    path: str
    hosts: tuple[str, str] = ("api.kiwoom.com", "mockapi.kiwoom.com")


# No order, account, trade history, watchlist mutation, proxy, or CNBC entry
# exists in this allowlist.  API ID + exact path + configured host are checked.
ALLOWED_CALLS = {
    ('ka10021', '/api/dostk/rkinfo'),
    ('ka10022', '/api/dostk/rkinfo'),
    ('ka10025', '/api/dostk/stkinfo'),
    ('ka10029', '/api/dostk/rkinfo'),
    ('ka10055', '/api/dostk/stkinfo'),
    ('ka10098', '/api/dostk/rkinfo'),

    # Reviewed read-only market analysis contracts.
    ('ka10005', '/api/dostk/mrkcond'),
    ('ka10006', '/api/dostk/mrkcond'),
    ('ka10007', '/api/dostk/mrkcond'),
    ('ka10015', '/api/dostk/stkinfo'),
    ('ka10044', '/api/dostk/mrkcond'),
    ('ka10045', '/api/dostk/mrkcond'),
    ('ka10046', '/api/dostk/mrkcond'),
    ('ka10047', '/api/dostk/mrkcond'),
    ('ka10054', '/api/dostk/stkinfo'),
    ('ka10058', '/api/dostk/stkinfo'),
    ('ka10060', '/api/dostk/chart'),
    ('ka10061', '/api/dostk/stkinfo'),
    ('ka10063', '/api/dostk/mrkcond'),
    ('ka10064', '/api/dostk/chart'),
    ('ka10066', '/api/dostk/mrkcond'),
    ('ka10086', '/api/dostk/mrkcond'),
    ('ka10087', '/api/dostk/mrkcond'),
    ('ka90007', '/api/dostk/mrkcond'),
    ('ka90008', '/api/dostk/mrkcond'),
    ('ka90010', '/api/dostk/mrkcond'),
    ('usa20880', '/api/us/rkinfo'),
    ('usa20881', '/api/us/rkinfo'),
    ('usa20910', '/api/us/rkinfo'),
    ('usa20911', '/api/us/rkinfo'),
    ('usa20920', '/api/us/rkinfo'),
    ('usa20921', '/api/us/rkinfo'),
    ('usa20922', '/api/us/rkinfo'),
    ('usa20940', '/api/us/rkinfo'),
    ('usa20941', '/api/us/rkinfo'),
    ('usa20960', '/api/us/rkinfo'),
    ('usa20961', '/api/us/rkinfo'),
    ('usa26410', '/api/us/stkinfo'),
    ('usa26411', '/api/us/stkinfo'),
    ('usa26412', '/api/us/stkinfo'),
    ('usa26413', '/api/us/stkinfo'),
    ('usa26414', '/api/us/stkinfo'),

    ("ka10099", "/api/dostk/stkinfo"), ("ka10001", "/api/dostk/stkinfo"),
    ("ka10004", "/api/dostk/mrkcond"), ("ka10080", "/api/dostk/chart"),
    ("ka10081", "/api/dostk/chart"), ("ka10082", "/api/dostk/chart"), ("ka10083", "/api/dostk/chart"),
    ("ka10094", "/api/dostk/chart"), ("ka20005", "/api/dostk/chart"),
    ("ka20006", "/api/dostk/chart"), ("ka20007", "/api/dostk/chart"),
    ("ka20008", "/api/dostk/chart"), ("ka20019", "/api/dostk/chart"),
    ("ka10027", "/api/dostk/rkinfo"), ("ka10030", "/api/dostk/rkinfo"),
    ("ka10032", "/api/dostk/rkinfo"), ("ka10059", "/api/dostk/stkinfo"),
    ("ka00198", "/api/dostk/stkinfo"), ("ka10017", "/api/dostk/stkinfo"),
    ("ka10095", "/api/dostk/stkinfo"), ("ka01300", "/api/dostk/watchlist"),
    ("ka01301", "/api/dostk/watchlist"), ("ka10051", "/api/dostk/sect"),
    ("ka20001", "/api/dostk/sect"), ("ka20002", "/api/dostk/sect"),
    ("ka20003", "/api/dostk/sect"), ("ka20009", "/api/dostk/sect"),
    ("usa20100", "/api/us/mrkcond"), ("usa20101", "/api/us/mrkcond"),
    ("usa06011", "/api/us/chart"), ("usa06012", "/api/us/chart"),
    ("usa06013", "/api/us/chart"), ("usa06014", "/api/us/chart"), ("usa06015", "/api/us/chart"),
    ("usa10098", "/api/us/stkinfo"), ("usa10099", "/api/us/stkinfo"),
    ("usa20200", "/api/us/watchlist"), ("usa20201", "/api/us/watchlist"),
    # Public-market analysis contracts reviewed against installed official SDK metadata.
    ("ka10016", "/api/dostk/stkinfo"), ("ka10018", "/api/dostk/stkinfo"),
    ("ka10019", "/api/dostk/stkinfo"), ("ka10020", "/api/dostk/rkinfo"),
    ("ka10023", "/api/dostk/rkinfo"), ("ka10024", "/api/dostk/stkinfo"),
    ("ka10026", "/api/dostk/stkinfo"), ("ka10033", "/api/dostk/rkinfo"),
    ("ka10034", "/api/dostk/rkinfo"),
    ("ka10002", "/api/dostk/stkinfo"), ("ka10003", "/api/dostk/stkinfo"),
    ("ka10008", "/api/dostk/frgnistt"), ("ka10013", "/api/dostk/stkinfo"),
    ("ka10014", "/api/dostk/shsa"), ("ka10068", "/api/dostk/slb"),
    ("ka40001", "/api/dostk/etf"), ("ka40002", "/api/dostk/etf"),
    ("ka40004", "/api/dostk/etf"), ("ka40009", "/api/dostk/etf"),
    ("ka90001", "/api/dostk/thme"), ("ka90002", "/api/dostk/thme"),
    ("ka90003", "/api/dostk/stkinfo"), ("ka90004", "/api/dostk/stkinfo"),
    ("ka90005", "/api/dostk/mrkcond"), ("ka90006", "/api/dostk/mrkcond"),
    ("ka90013", "/api/dostk/mrkcond"),
    ("usa20150", "/api/us/mrkcond"), ("usa20151", "/api/us/mrkcond"),
    ("usa01980", "/api/us/rkinfo"), ("usa01990", "/api/us/rkinfo"),
    ("usa20510", "/api/us/rkinfo"), ("usa20530", "/api/us/rkinfo"),
    ("usa20540", "/api/us/rkinfo"), ("usa20550", "/api/us/rkinfo"),
    ("usa23000", "/api/us/sect"), ("usa23100", "/api/us/sect"),
    ("usa20520", "/api/us/stkinfo"), ("usa24100", "/api/us/stkinfo"),
    ("usa24140", "/api/us/stkinfo"), ("usa20930", "/api/us/stkinfo"),
    ("usa24200", "/api/us/rkinfo"), ("usa24300", "/api/us/invtinfo"),
}
REALTIME_CALL = ("FT", "/api/us/websocket")  # legacy parser compatibility
REALTIME_CALLS = {"KR": (frozenset({"0B", "0D"}), "/api/dostk/websocket"), "US": (frozenset({"FE", "FT"}), "/api/us/websocket")}
CHART_INTERVALS = frozenset({"1", "3", "5", "10", "15", "30", "45", "60", "D", "W", "M", "Y"})
_HOSTS = {"real": "api.kiwoom.com", "demo": "mockapi.kiwoom.com"}
_KR_CODE = re.compile(r"^[0-9A-Z]{6}$")
_US_CODE = re.compile(r"^[A-Z][A-Z0-9.]{0,14}$")
_lock = Lock()
_status = {"connected": False, "mode": ENVIRONMENT, "error": ""}
_quote_cache: dict[tuple[str, ...], tuple[float, dict]] = {}
_chart_cache: dict[tuple[str, ...], tuple[float, dict]] = {}
_index_cache: dict[tuple[str, str], tuple[float, list[dict], bool, str]] = {}
_index_loading: set[tuple[str, str]] = set()
_index_lock = Lock()
_exact_cache: dict[str, tuple[float, list[dict]]] = {}
_last_call: dict[str, float] = {}
_last_global_call = 0.0
_pacer_lock = Lock()
_transport_installed = False
_original_session_request: Any = None
_read_locks = tuple(Lock() for _ in range(128))


def _shared_read(function):
    """Collapse concurrent reads for a feed without an unbounded lock map."""
    @wraps(function)
    def shared(**kwargs):
        identity = _identity(market=kwargs["market"], stk_cd=kwargs["stk_cd"], stex_tp=kwargs.get("stex_tp"), listing_venue=kwargs.get("listing_venue"))
        key = _cache_key(identity, function.__name__, str(kwargs.get("interval", kwargs.get("book", True))))
        with _read_locks[hash(key) % len(_read_locks)]:
            return function(**kwargs)
    return shared


def _remember(cache: dict, key: tuple, value: dict, limit: int) -> None:
    with _lock:
        if key not in cache and len(cache) >= limit:
            oldest = min(cache, key=lambda item: cache[item][0])
            cache.pop(oldest, None)
        cache[key] = (time.monotonic(), dict(value))
        if cache is _chart_cache:
            # Bound total historical data, not only the number of symbols.
            while len(cache) > 1 and sum(len(item[1].get("bars", [])) for item in cache.values()) > 150000:
                oldest = min((item for item in cache if item != key), key=lambda item: cache[item][0])
                cache.pop(oldest, None)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_message(_exc: Exception) -> str:
    """Provider text can contain arbitrary data; never surface any of it."""
    return "Kiwoom request failed"


def _number(value: object, *, absolute: bool = False, price: bool = False) -> float | None:
    """Parse Kiwoom decimal strings without erasing sign semantics.

    Price fields can carry a directional sign, so their displayed magnitude is
    absolute; change and rate fields retain their signed value.  Zero is not a
    live price but remains valid for quantities and signed change values.
    """
    if value is None or str(value).strip() in {"", "-"}:
        return None
    raw = str(value).strip().replace(",", "")
    try:
        decimal = Decimal(raw)
        if not decimal.is_finite():
            return None
        value_float = float(decimal)
    except (InvalidOperation, ValueError):
        return None
    if not math.isfinite(value_float):
        return None
    if price and value_float == 0:
        return None
    return abs(value_float) if absolute else value_float


def to_float(value: object, default: float = 0.0) -> float:
    """Compatibility helper used by the FT parser; not used for signed data."""
    parsed = _number(value)
    return default if parsed is None else parsed


def exchange_code(value: object, fallback: str = "ND") -> str:
    text = str(value or "").strip().upper()
    if text in {"ND", "NY", "NA"}:
        return text
    if "NASDAQ" in text:
        return "ND"
    if "NYSE" in text:
        return "NY"
    if "AMEX" in text:
        return "NA"
    return fallback


def _listing_for(market: str, venue: str) -> str:
    if market == "KR":
        return venue if venue in {"KOSPI", "KOSDAQ"} else "KOSPI"
    return {"ND": "NASDAQ", "NY": "NYSE", "NA": "AMEX"}.get(venue, "NASDAQ")


def _identity(*, market: str, stk_cd: str, stex_tp: str | None, listing_venue: str | None) -> dict:
    market = market.upper()
    if market not in {"KR", "US"}:
        raise BrokerError("market must be KR or US")
    if market == "KR":
        code = stk_cd.strip().upper()
        if not _KR_CODE.fullmatch(code):
            raise BrokerError("KR stk_cd must be a six-character KRX code")
        if stex_tp and str(stex_tp).upper() != "KRX":
            raise BrokerError("KR stex_tp must be KRX")
        listing = (listing_venue or "KOSPI").upper()
        if listing not in {"KOSPI", "KOSDAQ"}:
            raise BrokerError("KR listing_venue must be KOSPI or KOSDAQ")
        venue = "KRX"
        currency = "KRW"
    else:
        code = stk_cd.strip().upper().upper()
        if not _US_CODE.fullmatch(code):
            raise BrokerError("US stk_cd is invalid")
        venue = str(stex_tp or "ND").upper()
        if venue not in {"ND", "NY", "NA"}:
            raise BrokerError("US stex_tp must be ND, NY, or NA")
        listing = (listing_venue or _listing_for("US", venue)).upper()
        if listing != _listing_for("US", venue):
            raise BrokerError("US listing_venue does not match stex_tp")
        currency = "USD"
    return {
        "market": market, "stkCd": code, "stexTp": venue,
        "listingVenue": listing, "quoteVenue": venue,
        "currency": currency, "environment": ENVIRONMENT,
    }


def _cache_key(identity: dict, kind: str, extra: str = "") -> tuple[str, ...]:
    return tuple(str(identity[key]) for key in ("environment", "market", "stkCd", "listingVenue", "quoteVenue")) + (kind, extra)


def status() -> dict:
    with _lock:
        return dict(_status)


def _set_status(*, connected: bool, error: str = "") -> None:
    with _lock:
        _status.update({"connected": connected, "mode": ENVIRONMENT, "error": error})


def _set_request_status(*, connected: bool | None, error: str) -> None:
    """Record one safe request result without inventing a connection state."""
    with _lock:
        _status.update({
            "connected": _status["connected"] if connected is None else connected,
            "mode": ENVIRONMENT,
            "error": error,
        })


def _rejected_request_error(api_id: str, code: object = None) -> str:
    """Expose at most an explicit numeric SDK/provider code, never its text."""
    text = str(code).strip()
    if re.fullmatch(r"-?\d{1,10}", text):
        return f"Kiwoom {api_id} rejected request (code {text})"
    return f"Kiwoom {api_id} rejected request"


def ping() -> dict:
    # Deliberately does not construct an SDK client or request a token.
    if not KIWOOM_ENABLED:
        _set_status(connected=False, error="fixture environment")
    return status()


def _validate_url(url: str, *, websocket: bool = False, allow_api_path: bool = False) -> None:
    expected_host = _HOSTS[KIWOOM_MODE]
    parsed = urlparse(url)
    expected_scheme = "wss" if websocket else "https"
    if parsed.scheme != expected_scheme or parsed.hostname != expected_host or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RequestDenied("broker endpoint is not allowed")
    try:
        port = parsed.port
    except ValueError as exc:
        raise RequestDenied("broker endpoint is not allowed") from exc
    allowed_ports = {10000} if websocket else {None, 443}
    if port not in allowed_ports:
        raise RequestDenied("broker endpoint is not allowed")
    if not allow_api_path and parsed.path not in {"", "/"}:
        raise RequestDenied("broker base URL must not contain a path")
    allowed_paths = {entry[1] for entry in REALTIME_CALLS.values()} if websocket else {"/oauth2/token", "/oauth2/revoke", *(path for _, path in ALLOWED_CALLS)}
    if allow_api_path and parsed.path not in allowed_paths:
        raise RequestDenied("broker path is not allowed")


def _install_safe_transport() -> None:
    """Install an app-owned requests gate and disable redirect following.

    The official SDK's token issuance uses ``requests.post`` directly while
    API calls use a Session. Patching the Session method covers both without
    editing SDK sources and blocks a redirect to an arbitrary host.
    """
    global _transport_installed, _original_session_request
    if _transport_installed:
        return
    import requests
    original = requests.sessions.Session.request

    def guarded_request(session: Any, method: str, url: str, **kwargs: Any) -> Any:
        _validate_url(str(url), allow_api_path=True)
        parsed = urlparse(str(url))
        headers = kwargs.get("headers") or {}
        api_id = next((value for key, value in headers.items() if str(key).lower() == "api-id"), None)
        if parsed.path in {"/oauth2/token", "/oauth2/revoke"}:
            if method.upper() != "POST" or api_id is not None:
                raise RequestDenied("broker authentication request is not allowed")
        elif method.upper() != "POST" or (str(api_id), parsed.path) not in ALLOWED_CALLS:
            # This is the final check immediately before requests opens a
            # socket. It binds the SDK-generated path to its api-id too.
            raise RequestDenied("broker API id, path, or method is not allowed")
        # The SDK's auth helper creates its own requests.Session, so setting
        # this here covers both token and API requests and prevents a proxy
        # environment variable from becoming an unreviewed outbound hop.
        session.trust_env = False
        kwargs["allow_redirects"] = False
        return original(session, method, url, **kwargs)

    requests.sessions.Session.request = guarded_request
    _original_session_request = original
    _transport_installed = True


def _verify_sdk_endpoints(*, realtime: bool) -> None:
    """Read actual SDK endpoint config before constructing an auth client."""
    try:
        from kiwoom import get_base_url, get_ws_base_url
        _validate_url(get_base_url(KIWOOM_MODE))
        if realtime:
            _validate_url(get_ws_base_url(KIWOOM_MODE), websocket=True)
        _install_safe_transport()
    except RequestDenied:
        raise
    except Exception as exc:
        raise RequestDenied("broker endpoint verification failed") from exc


def _policy(api_id: str, path: str) -> AllowedCall:
    if not KIWOOM_ENABLED:
        raise RequestDenied("broker reads are disabled in fixture environment")
    if (api_id, path) not in ALLOWED_CALLS:
        raise RequestDenied("read-only policy denied this API request")
    host = _HOSTS.get(KIWOOM_MODE)
    if host is None:
        raise RequestDenied("broker environment is not configured")
    allowed = AllowedCall(api_id, path)
    if host not in allowed.hosts:
        raise RequestDenied("broker host is not allowed")
    _verify_sdk_endpoints(realtime=False)
    return allowed


def assert_realtime_allowed(*, market: str = "US") -> None:
    """Gate official market-data websocket creation before auth/connect."""
    if not KIWOOM_ENABLED or _HOSTS.get(KIWOOM_MODE) is None:
        raise RequestDenied("realtime subscription is disabled")
    if market not in REALTIME_CALLS:
        raise RequestDenied("realtime policy denied this market")
    _verify_sdk_endpoints(realtime=True)


def assert_auth_allowed() -> None:
    """Gate token issuance before an SDK auth object can open a socket."""
    if not KIWOOM_ENABLED or _HOSTS.get(KIWOOM_MODE) is None:
        raise RequestDenied("broker authentication is disabled")
    _verify_sdk_endpoints(realtime=False)


credential_manager.set_authorizer(assert_auth_allowed)


async def open_realtime(uri: str, timeout_seconds: int) -> Any:
    """SDK connect-factory that disables proxy use and every redirect."""
    _validate_url(uri, websocket=True, allow_api_path=True)
    try:
        from websockets.asyncio.client import connect
        connector = connect(uri, open_timeout=timeout_seconds, ping_interval=None, proxy=None)
        # websockets follows redirects by default. Its public connect object
        # permits overriding this decision before the first socket is opened.
        connector.process_redirect = lambda exc: exc
        return await connector
    except RequestDenied:
        raise
    except Exception as exc:
        raise BrokerError("Market-data connection failed") from exc


def _pace(api_id: str) -> None:
    # Conservative documented ceilings: usa10099 5/min; demo 1/TR/sec; US
    # 09:00 KST window 3/sec; otherwise 5/sec. This is a local single-process
    # limiter, not the M1 central budget scheduler.
    global _last_global_call
    kst_hour = (datetime.now(timezone.utc).hour + 9) % 24
    global_gap = 1 / 3 if api_id.startswith("usa") and kst_hour == 9 else 0.2
    api_gap = 12.0 if api_id == "usa10099" else (1.0 if KIWOOM_MODE == "demo" else 0.0)
    while True:
        with _pacer_lock:
            now = time.monotonic()
            wait = max(_last_global_call + global_gap - now, _last_call.get(api_id, 0.0) + api_gap - now)
            if wait <= 0:
                _last_global_call, _last_call[api_id] = now, now
                return
        # A slow universe-list budget must not hold up unrelated quotes.
        # Recheck atomically after waking: another request may have proceeded.
        time.sleep(wait)


def _client() -> Any:
    from kiwoom import get_client
    # HTTP and realtime clients receive the same process-wide managed auth.
    # ``_policy`` has already run before this factory is reached.
    return get_client(auth=credential_manager.sdk_auth())


def ws_client() -> Any:
    """Build an official SDK websocket client sharing the managed auth."""
    from kiwoom import get_ws_client

    return get_ws_client(auth=credential_manager.sdk_auth())


class _PinnedWebSocketAuth:
    """Non-blocking per-connect view of the process-wide managed token."""

    def __init__(self, token: str) -> None:
        self.mode = KIWOOM_MODE
        self._token = token
        self.auth_retry_requested = False

    def get_access_token(self) -> str:
        return self._token

    def authorization_header(self) -> str:
        return f"Bearer {self._token}"

    def recover_from_auth_failure(self) -> str:
        # The SDK makes this call synchronously from its asyncio connect
        # method. Mark it and return immediately; market_stream performs the
        # actual one-shot manager recovery with asyncio.to_thread.
        self.auth_retry_requested = True
        return self._token


def websocket_auth_snapshot() -> tuple[str, int]:
    return credential_manager.websocket_auth_snapshot()


def recover_websocket_auth(observed_generation: int) -> tuple[str, int]:
    return credential_manager.recover_websocket_auth(observed_generation)


def ws_client_for_token(token: str) -> Any:
    from kiwoom import get_ws_client

    return get_ws_client(auth=_PinnedWebSocketAuth(token))


def _fetch_page(api_id: str, path: str, body: dict, *, cont_yn: str | None = None, next_key: str | None = None) -> Any:
    _policy(api_id, path)  # Must stay before _client / token creation.
    _pace(api_id)
    try:
        response = _client().fetch_page(api_id=api_id, path=path, body=body, cont_yn=cont_yn, next_key=next_key)
    except Exception as exc:  # SDK exceptions may include raw provider text.
        # The installed SDK gives business rejections typed API/HTTP errors;
        # only auth or a transport exception proves this process is offline.
        from kiwoom.core.errors import APIError, AuthenticationError, HTTPRequestError
        import requests

        if isinstance(exc, AuthenticationError):
            _set_request_status(connected=False, error="Kiwoom authentication failed")
        elif isinstance(exc, requests.exceptions.RequestException):
            _set_request_status(connected=False, error="Kiwoom transport unavailable")
        elif isinstance(exc, APIError):
            _set_request_status(connected=True, error=_rejected_request_error(api_id, exc.return_code))
        elif isinstance(exc, HTTPRequestError):
            _set_request_status(connected=True, error=_rejected_request_error(api_id))
        else:
            # An SDK/local programming failure does not establish a new
            # connection and must not erase the last known reachability.
            _set_request_status(connected=None, error="Kiwoom request failed")
        raise BrokerError(f"Kiwoom {api_id} request failed", provider_code=exc.return_code if isinstance(exc, APIError) else None) from exc
    payload = getattr(response, "body", None) or {}
    if not isinstance(payload, dict):
        _set_request_status(connected=True, error="Kiwoom response was invalid")
        raise BrokerError(f"Kiwoom {api_id} returned an invalid payload")
    from kiwoom.core.errors import AuthenticationError, normalize_return_code, raise_for_error_code

    code = normalize_return_code(payload.get("return_code"))
    if code not in (None, 0, "0"):
        try:
            raise_for_error_code(code, str(payload.get("return_msg") or ""))
        except AuthenticationError:
            _set_request_status(connected=False, error="Kiwoom authentication failed")
        except Exception:
            _set_request_status(connected=True, error=_rejected_request_error(api_id, code))
        raise BrokerError(f"Kiwoom {api_id} returned an error", provider_code=code)
    _set_status(connected=True)
    return response


def _continuation(response: Any) -> tuple[bool, str | None, str | None]:
    continuation = getattr(response, "continuation", None)
    if continuation is not None:
        return bool(getattr(continuation, "has_next", False)), getattr(continuation, "cont_yn", None), getattr(continuation, "next_key", None)
    headers = getattr(response, "headers", {}) or {}
    cont = headers.get("cont-yn") or headers.get("Cont-Yn")
    return cont == "Y", cont, headers.get("next-key") or headers.get("Next-Key")


def _fetch_rows(api_id: str, path: str, body: dict, list_key: str, *, max_pages: int = 32) -> tuple[list[dict], bool, str]:
    rows: list[dict] = []
    cont_yn: str | None = None
    next_key: str | None = None
    seen: set[str] = set()
    for page_number in range(max_pages):
        response = _fetch_page(api_id, path, body, cont_yn=cont_yn, next_key=next_key)
        payload = getattr(response, "body", None)
        if not isinstance(payload, dict) or list_key not in payload:
            raise BrokerError(f"Kiwoom {api_id} omitted its result list")
        page = payload[list_key]
        if not isinstance(page, list):
            raise BrokerError(f"Kiwoom {api_id} returned an invalid list")
        rows.extend(row for row in page if isinstance(row, dict))
        has_next, cont_yn, next_key = _continuation(response)
        if not has_next:
            return rows, True, ""
        if not next_key:
            return rows, False, "continuation key missing"
        if next_key in seen:
            return rows, False, "continuation key repeated"
        seen.add(next_key)
        if not page:
            return rows, False, "continuation page empty"
    return rows, False, f"pagination capped at {max_pages} pages"


def _base_quote(identity: dict, *, name: str, source: str, note: str = "") -> dict:
    received_at = _now()
    return {
        **identity, "stkNm": name, "last": None, "open": None, "high": None, "low": None,
        "prevClose": None, "change": None, "changePct": None, "volume": None, "bid": None,
        "ask": None, "bidQty": None, "askQty": None, "midPrice": None, "asks": [], "bids": [],
        "rawPrices": {}, "source": source, "status": "snapshot", "receivedAt": received_at,
        "tradeReceivedAt": received_at, "priceReceivedAt": received_at,
        "volumeReceivedAt": received_at, "bookReceivedAt": None, "sourceTimestamp": None,
        "note": note, "bookLive": False, "bookNote": "",
    }


_FIXTURE_INSTRUMENTS = [
    {"market": "KR", "stkCd": "005930", "stkNm": "삼성전자", "stexTp": "KRX", "listingVenue": "KOSPI"},
    {"market": "KR", "stkCd": "000660", "stkNm": "SK하이닉스", "stexTp": "KRX", "listingVenue": "KOSPI"},
    {"market": "KR", "stkCd": "035720", "stkNm": "카카오", "stexTp": "KRX", "listingVenue": "KOSPI"},
    {"market": "KR", "stkCd": "247540", "stkNm": "에코프로비엠", "stexTp": "KRX", "listingVenue": "KOSDAQ"},
    {"market": "US", "stkCd": "NVDA", "stkNm": "NVIDIA", "stexTp": "ND", "listingVenue": "NASDAQ"},
    {"market": "US", "stkCd": "AAPL", "stkNm": "Apple", "stexTp": "ND", "listingVenue": "NASDAQ"},
    {"market": "US", "stkCd": "BRK.B", "stkNm": "Berkshire Hathaway B", "stexTp": "NY", "listingVenue": "NYSE"},
]
_FIXTURE_PRICES = {
    ("KR", "005930"): (71500.0, 71000.0, 70200.0, 72100.0, 69800.0, 500.0, 0.70, 11200000.0),
    ("KR", "000660"): (185000.0, 182000.0, 181500.0, 186000.0, 180500.0, 3000.0, 1.64, 2300000.0),
    ("KR", "247540"): (128000.0, 129000.0, 129100.0, 129800.0, 127500.0, -1000.0, -0.78, 410000.0),
    ("KR", "035720"): (51000.0, 50000.0, 50200.0, 51500.0, 49800.0, 1000.0, 2.0, 1900000.0),
    ("US", "NVDA"): (177.82, 174.10, 175.40, 179.10, 174.90, 3.72, 2.14, 32000000.0),
    ("US", "AAPL"): (228.40, 226.90, 227.20, 229.10, 226.80, 1.50, 0.66, 22000000.0),
    ("US", "BRK.B"): (498.20, 495.00, 496.10, 499.00, 494.80, 3.20, 0.65, 600000.0),
}


def _fixture_instrument(identity: dict) -> dict:
    for row in _FIXTURE_INSTRUMENTS:
        if row["market"] == identity["market"] and row["stkCd"] == identity["stkCd"]:
            candidate = _identity(market=row["market"], stk_cd=row["stkCd"], stex_tp=row["stexTp"], listing_venue=row["listingVenue"])
            if all(candidate[key] == identity[key] for key in ("market", "stkCd", "listingVenue", "quoteVenue")):
                return {**candidate, "stkNm": row["stkNm"]}
            break
    return {**identity, "stkNm": identity["stkCd"]}


def _fixture_book(last: float | None, currency: str) -> tuple[list[dict], list[dict]]:
    if last is None:
        return [], []
    step = 100.0 if currency == "KRW" else 0.01
    ask_sizes = (1832, 4270, 1065, 7620, 2940, 11800, 3560, 6240, 2180, 4840)
    bid_sizes = (2940, 6150, 1820, 9400, 3570, 4290, 1560, 7120, 3860, 5410)
    asks = [{"price": round(last + step * n, 4), "qty": float(ask_sizes[n - 1])} for n in range(10, 0, -1)]
    bids = [{"price": round(last - step * n, 4), "qty": float(bid_sizes[n - 1])} for n in range(1, 11)]
    return asks, bids


def _fixture_quote(identity: dict, *, book: bool) -> dict:
    row = _fixture_instrument(identity)
    quote = _base_quote(identity, name=row["stkNm"], source="fixture", note="Deterministic fixture data; not broker data.")
    values = _FIXTURE_PRICES.get((identity["market"], identity["stkCd"])) if row["stkNm"] != identity["stkCd"] else None
    if values:
        fields = ("last", "prevClose", "open", "high", "low", "change", "changePct", "volume")
        quote.update(dict(zip(fields, values)))
        quote["rawPrices"] = {key: str(value) for key, value in quote.items() if key in {"last", "prevClose", "open", "high", "low", "change", "changePct"}}
        if book:
            asks, bids = _fixture_book(quote["last"], identity["currency"])
            quote.update({"asks": asks, "bids": bids, "ask": asks[-1]["price"], "bid": bids[0]["price"], "askQty": asks[-1]["qty"], "bidQty": bids[0]["qty"], "midPrice": (asks[-1]["price"] + bids[0]["price"]) / 2, "bookReceivedAt": quote["receivedAt"]})
    else:
        quote["status"] = "missing"
        quote["note"] = "Fixture has no quote for this symbol."
    return quote


def _raw(body: dict, *keys: str) -> dict:
    return {key: str(body[key]) for key in keys if body.get(key) not in (None, "")}


def _kr_quote(identity: dict, *, book: bool) -> dict:
    response = _fetch_page("ka10001", "/api/dostk/stkinfo", {"stk_cd": identity["stkCd"]})
    body = getattr(response, "body", {}) or {}
    returned = str(body.get("stk_cd") or identity["stkCd"]).strip()
    if returned != identity["stkCd"]:
        raise BrokerError("Kiwoom returned a different KR symbol")
    quote = _base_quote(identity, name=str(body.get("stk_nm") or identity["stkCd"]), source="kiwoom")
    quote.update({
        "last": _number(body.get("cur_prc"), absolute=True, price=True),
        "prevClose": _number(body.get("base_pric"), absolute=True, price=True),
        "open": _number(body.get("open_pric"), absolute=True, price=True),
        "high": _number(body.get("high_pric"), absolute=True, price=True),
        "low": _number(body.get("low_pric"), absolute=True, price=True),
        "change": _number(body.get("pred_pre")), "changePct": _number(body.get("flu_rt")),
        "volume": _number(body.get("trde_qty"), absolute=True),
        "rawPrices": _raw(body, "cur_prc", "base_pric", "open_pric", "high_pric", "low_pric", "pred_pre", "flu_rt"),
    })
    if book:
        book_response = _fetch_page("ka10004", "/api/dostk/mrkcond", {"stk_cd": identity["stkCd"]})
        _attach_kr_book(quote, getattr(book_response, "body", {}) or {})
    return quote


def _attach_kr_book(quote: dict, body: dict) -> None:
    if body.get("stk_cd") and str(body["stk_cd"]).strip() != quote["stkCd"]:
        raise BrokerError("Kiwoom returned a different KR order book")
    asks, bids = [], []
    for level in range(10, 0, -1):
        prefix = "fpr" if level == 1 else f"{level}th_pre"
        price = _number(body.get(f"sel_{prefix}_bid"), absolute=True, price=True)
        qty = _number(body.get(f"sel_{prefix}_req"), absolute=True)
        if price is not None:
            asks.append({"price": price, "qty": qty})
    for level in range(1, 11):
        prefix = "fpr" if level == 1 else f"{level}th_pre"
        price = _number(body.get(f"buy_{prefix}_bid"), absolute=True, price=True)
        qty = _number(body.get(f"buy_{prefix}_req"), absolute=True)
        if price is not None:
            bids.append({"price": price, "qty": qty})
    quote.update({"asks": asks, "bids": bids, "ask": asks[-1]["price"] if asks else None, "bid": bids[0]["price"] if bids else None, "askQty": asks[-1]["qty"] if asks else None, "bidQty": bids[0]["qty"] if bids else None})
    if asks and bids:
        quote["midPrice"] = (asks[-1]["price"] + bids[0]["price"]) / 2
    quote["bookNote"] = "KRX 10-level snapshot; bid_req_base_tm has no date and is not an ISO source timestamp."
    quote["bookReceivedAt"] = quote["receivedAt"] = _now()


def _us_quote(identity: dict, *, book: bool) -> dict:
    body = getattr(_fetch_page("usa20100", "/api/us/mrkcond", {"stex_tp": identity["stexTp"], "stk_cd": identity["stkCd"]}), "body", {}) or {}
    returned_code = str(body.get("stk_cd") or identity["stkCd"]).strip().upper()
    returned_venue = exchange_code(body.get("stex_tp"), identity["stexTp"])
    if returned_code != identity["stkCd"] or returned_venue != identity["stexTp"]:
        raise BrokerError("Kiwoom returned a different US instrument")
    quote = _base_quote(identity, name=str(body.get("stk_nm") or body.get("stk_enm") or identity["stkCd"]), source="kiwoom")
    quote.update({
        "last": _number(body.get("cur_prc"), absolute=True, price=True), "prevClose": _number(body.get("base_close_pric"), absolute=True, price=True),
        "open": _number(body.get("open_pric"), absolute=True, price=True), "high": _number(body.get("high_pric"), absolute=True, price=True),
        "low": _number(body.get("low_pric"), absolute=True, price=True), "change": _number(body.get("pred_pre")),
        "changePct": _number(body.get("flu_rt")), "volume": _number(body.get("acc_trde_qty"), absolute=True),
        "rawPrices": _raw(body, "cur_prc", "base_close_pric", "open_pric", "high_pric", "low_pric", "pred_pre", "flu_rt"),
    })
    if book:
        book_body = getattr(_fetch_page("usa20101", "/api/us/mrkcond", {"stex_tp": identity["stexTp"], "stk_cd": identity["stkCd"]}), "body", {}) or {}
        book_code = str(book_body.get("stk_cd") or identity["stkCd"]).strip().upper()
        book_venue = exchange_code(book_body.get("stex_tp"), identity["stexTp"])
        if book_code != identity["stkCd"] or book_venue != identity["stexTp"]:
            raise BrokerError("Kiwoom returned a different US order book")
        _attach_us_book(quote, book_body)
    return quote


def _attach_us_book(quote: dict, body: dict) -> None:
    asks, bids = [], []
    for level in range(10, 0, -1):
        price = _number(body.get(f"sel_{level}bid"), absolute=True, price=True)
        qty = _number(body.get(f"sel_{level}bid_req"), absolute=True)
        if price is not None:
            asks.append({"price": price, "qty": qty})
    for level in range(1, 11):
        price = _number(body.get(f"buy_{level}bid"), absolute=True, price=True)
        qty = _number(body.get(f"buy_{level}bid_req"), absolute=True)
        if price is not None:
            bids.append({"price": price, "qty": qty})
    quote.update({"asks": asks, "bids": bids, "ask": asks[-1]["price"] if asks else _number(body.get("fpr_sel_bid"), absolute=True, price=True), "bid": bids[0]["price"] if bids else _number(body.get("fpr_buy_bid"), absolute=True, price=True), "askQty": asks[-1]["qty"] if asks else None, "bidQty": bids[0]["qty"] if bids else None})
    if asks and bids:
        quote["midPrice"] = (asks[-1]["price"] + bids[0]["price"]) / 2
    quote["bookNote"] = "US REST 10-level snapshot; realtime freshness is reported separately."
    quote["bookReceivedAt"] = quote["receivedAt"] = _now()


@_shared_read
def get_quote(*, market: str, stk_cd: str, stex_tp: str | None = None, listing_venue: str | None = None, book: bool = True) -> dict:
    identity = _identity(market=market, stk_cd=stk_cd, stex_tp=stex_tp, listing_venue=listing_venue)
    key = _cache_key(identity, "quote", "book" if book else "lite")
    cached = _quote_cache.get(key)
    if cached and time.monotonic() - cached[0] < 3:
        return dict(cached[1])
    quote = _fixture_quote(identity, book=book) if not KIWOOM_ENABLED else (_kr_quote(identity, book=book) if identity["market"] == "KR" else _us_quote(identity, book=book))
    _remember(_quote_cache, key, quote, 512)
    return quote


def get_quote_lite(stex_tp: str, stk_cd: str) -> dict:
    """Legacy internal helper retained for the US FT hub only."""
    return get_quote(market="US", stk_cd=stk_cd, stex_tp=stex_tp, book=False)


def merge_stream(quote: dict, stream: dict | None) -> dict:
    """Merge only matching, newer data; a book frame cannot invent a trade."""
    if not stream or any(quote.get(key) != stream.get(key) for key in ("environment", "market", "stkCd", "listingVenue", "quoteVenue")):
        return dict(quote)
    merged = dict(quote)

    def timestamp(value: Any) -> float:
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
        except (ValueError, TypeError):
            return 0.0

    trade_at = timestamp(stream.get("priceReceivedAt", stream.get("tradeReceivedAt")))
    volume_at = timestamp(stream.get("volumeReceivedAt", stream.get("tradeReceivedAt")))
    book_at = timestamp(stream.get("bookReceivedAt"))
    if trade_at and trade_at >= timestamp(quote.get("tradeReceivedAt")):
        for key in ("last", "change", "changePct"):
            if stream.get(key) is not None:
                merged[key] = stream[key]
        merged["tradeReceivedAt"] = stream["tradeReceivedAt"]
        merged["priceReceivedAt"] = stream.get("priceReceivedAt", stream["tradeReceivedAt"])
        for key in ("tradeSourceTime", "observedMinute"):
            if key in stream:
                merged[key] = stream[key]
        merged["sourceTimestamp"] = stream.get("sourceTimestamp")
        # This field describes the last trade, not just an active socket.
        fresh_trade = stream.get("status") == "live" and time.time() - trade_at <= 10
        merged["status"] = "live" if fresh_trade else "stale"
        merged["priceLive"] = fresh_trade
        merged["note"] = "Broker trade event received." if fresh_trade else "Last broker trade event; no recent trade update."
    if volume_at and volume_at >= timestamp(quote.get("volumeReceivedAt", quote.get("tradeReceivedAt"))) and stream.get("volume") is not None:
        merged["volume"] = stream["volume"]
        merged["volumeReceivedAt"] = stream.get("volumeReceivedAt", stream.get("tradeReceivedAt"))
        merged["volumeLive"] = bool(stream.get("volumeLive", stream.get("status") == "live") and time.time() - volume_at <= 10)
    if book_at and book_at >= timestamp(quote.get("bookReceivedAt")):
        asks, bids = stream.get("asks") or [], stream.get("bids") or []
        merged.update({"asks": asks, "bids": bids, "ask": asks[-1]["price"] if asks else None, "bid": bids[0]["price"] if bids else None, "askQty": asks[-1].get("qty") if asks else None, "bidQty": bids[0].get("qty") if bids else None, "midPrice": (asks[-1]["price"] + bids[0]["price"]) / 2 if asks and bids else None, "bookReceivedAt": stream["bookReceivedAt"], "bookLive": bool(stream.get("bookLive")), "bookNote": "Broker book event." if stream.get("bookLive") else "Last received broker book; no recent update."})
        if "bookSourceTime" in stream:
            merged["bookSourceTime"] = stream["bookSourceTime"]
    latest = max((merged.get("receivedAt"), merged.get("tradeReceivedAt"), merged.get("bookReceivedAt"), merged.get("volumeReceivedAt")), key=timestamp)
    merged["receivedAt"] = latest
    return merged


def merge_book(quote: dict, book: dict | None) -> dict:
    if not book or quote.get("market") != "US":
        return quote
    identity_fields = ("environment", "market", "stkCd", "listingVenue", "quoteVenue")
    if any(book.get(key) != quote.get(key) for key in identity_fields):
        return quote
    if time.monotonic() - float(book.get("monotonicAt") or 0) > 5:
        return quote
    asks, bids = book.get("asks") or [], book.get("bids") or []
    if not asks and not bids:
        return quote
    merged = dict(quote)
    merged.update({"asks": asks, "bids": bids, "ask": asks[-1]["price"] if asks else None, "bid": bids[0]["price"] if bids else None, "askQty": asks[-1].get("qty") if asks else None, "bidQty": bids[0].get("qty") if bids else None, "bookLive": True, "status": "live", "bookReceivedAt": book.get("receivedAt") or _now(), "bookNote": "US FT single-symbol subscription (M0 limit); last trade is refreshed separately."})
    if asks and bids:
        merged["midPrice"] = (asks[-1]["price"] + bids[0]["price"]) / 2
    return merged


def _instrument_from_row(market: str, row: dict, *, default_venue: str) -> dict | None:
    code = str((row.get("code") if market == "KR" else row.get("stk_cd")) or "").strip()
    # One unsupported/malformed universe row must not discard every valid
    # symbol. KRX short codes can include letters; suffixes for other quote
    # venues remain unsupported until explicitly represented in the identity.
    if not (_KR_CODE if market == "KR" else _US_CODE).fullmatch(code):
        return None
    if market == "KR":
        venue = "KOSDAQ" if str(row.get("marketName") or "").upper().find("KOSDAQ") >= 0 or str(row.get("marketCode") or "") == "10" else "KOSPI"
        return {**_identity(market="KR", stk_cd=code, stex_tp="KRX", listing_venue=venue), "stkNm": str(row.get("name") or code), "last": None, "prevClose": _number(row.get("lastPrice"), absolute=True, price=True)}
    venue = exchange_code(row.get("stex_tp"), default_venue)
    return {**_identity(market="US", stk_cd=code, stex_tp=venue, listing_venue=_listing_for("US", venue)), "stkNm": str(row.get("stk_nm") or row.get("stk_enm") or code), "last": None, "prevClose": None}


def _fixture_search(query: str, market: str | None) -> tuple[list[dict], bool, str]:
    query = query.upper().strip()
    rows = []
    for row in _FIXTURE_INSTRUMENTS:
        if market and row["market"] != market:
            continue
        if query and query not in row["stkCd"] and query not in row["stkNm"].upper():
            continue
        item = _fixture_instrument(_identity(market=row["market"], stk_cd=row["stkCd"], stex_tp=row["stexTp"], listing_venue=row["listingVenue"]))
        rows.append({key: item[key] for key in ("market", "stkCd", "stkNm", "stexTp", "listingVenue", "quoteVenue", "currency", "environment")})
    return rows[:20], True, "Deterministic fixture search; not broker data."


def _as_rows(payload: dict, list_key: str, fields: tuple[str, ...]) -> list[dict]:
    block = payload.get(list_key)
    if isinstance(block, list):
        return [row for row in block if isinstance(row, dict)]
    first = payload.get(fields[0]) if fields else None
    if isinstance(first, list):
        return [{field: (payload.get(field)[index] if isinstance(payload.get(field), list) and index < len(payload.get(field)) else None) for field in fields} for index in range(len(first))]
    return []


def _confirmed_watchlist_rows(payload: object, *, list_key: str, failure: str) -> list[dict]:
    """Accept only a confirmed, complete HTS watchlist response.

    Watchlist import replaces the local copy of an imported group.  Missing
    lists or malformed identities must therefore fail before the store sees
    any group, rather than being normalized to an empty result.
    """
    if not isinstance(payload, dict) or payload.get("rtcd") != "S":
        raise BrokerError(failure)
    rows = payload.get(list_key)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise BrokerError(failure)
    return rows


def get_hts_watchlists(market: str = "US") -> list[dict]:
    """Explicit, read-only HTS import; never called from state/startup."""
    if market not in {"KR", "US"}:
        raise BrokerError("unsupported watchlist market")
    if market == "KR":
        if not KIWOOM_ENABLED:
            return [{"gcod": "KR_fixture", "name": "Fixture 국내", "items": [_fixture_instrument(_identity(market="KR", stk_cd="005930", stex_tp="KRX", listing_venue="KOSPI"))]}]
        indexed, complete, _ = _indexed("KR")
        if not complete:
            raise BrokerError("국내 종목 목록을 불러오는 중입니다. 잠시 후 가져오기를 다시 눌러 주세요.")
        by_code = {item["stkCd"]: item for item in indexed}
        payload = getattr(_fetch_page("ka01300", "/api/dostk/watchlist", {}), "body", None)
        source_groups = _confirmed_watchlist_rows(payload, list_key="nofi", failure="국내 HTS 관심그룹 조회에 실패했습니다. 기존 목록을 유지합니다.")
        groups = []
        group_ids: set[str] = set()
        for group in source_groups:
            raw_group_id, raw_name = group.get("gcod"), group.get("name")
            if not isinstance(raw_group_id, str) or not isinstance(raw_name, str):
                raise BrokerError("국내 HTS 관심그룹 형식이 올바르지 않습니다. 기존 목록을 유지합니다.")
            group_id, group_name = raw_group_id.strip(), raw_name.strip()
            if not re.fullmatch(r"\d{3}", group_id) or not group_name or len(group_name) > 120 or any(ord(char) < 32 for char in group_name) or group_id in group_ids:
                raise BrokerError("국내 HTS 관심그룹 형식이 올바르지 않습니다. 기존 목록을 유지합니다.")
            group_ids.add(group_id)
            detail = getattr(_fetch_page("ka01301", "/api/dostk/watchlist", {"arn_grp_id": group_id}), "body", None)
            source_items = _confirmed_watchlist_rows(detail, list_key="nofj", failure="국내 HTS 관심종목 조회에 실패했습니다. 기존 목록을 유지합니다.")
            items = []
            for row in source_items:
                raw_code = row.get("cod2")
                if not isinstance(raw_code, str):
                    raise BrokerError("국내 HTS 관심종목 식별자가 올바르지 않습니다. 기존 목록을 유지합니다.")
                code = raw_code.strip().upper()
                # HTS may return A-prefixed domestic identifiers.
                if len(code) == 7 and code.startswith("A"):
                    code = code[1:]
                if not _KR_CODE.fullmatch(code):
                    raise BrokerError("국내 HTS 관심종목 식별자가 올바르지 않습니다. 기존 목록을 유지합니다.")
                instrument = by_code.get(code)
                if instrument is None:
                    raise BrokerError("관심종목의 시장을 확인하지 못했습니다. 기존 목록을 유지합니다.")
                items.append(dict(instrument))
            # Prefix only the new KR namespace to preserve existing US imports.
            groups.append({"gcod": f"KR_{group_id}", "name": group_name, "items": items})
        return groups
    if not KIWOOM_ENABLED:
        return [{"gcod": "fixture-us", "name": "Fixture US", "items": [{**_fixture_instrument(_identity(market="US", stk_cd="BRK.B", stex_tp="NY", listing_venue="NYSE"))}]}]
    groups_body = getattr(_fetch_page("usa20200", "/api/us/watchlist", {}), "body", None)
    source_groups = _confirmed_watchlist_rows(groups_body, list_key="nofi", failure="해외 HTS 관심그룹 조회에 실패했습니다. 기존 목록을 유지합니다.")
    groups = []
    group_ids: set[str] = set()
    for group in source_groups:
        raw_group_id, raw_name = group.get("gcod"), group.get("name")
        if not isinstance(raw_group_id, str) or not isinstance(raw_name, str):
            raise BrokerError("해외 HTS 관심그룹 형식이 올바르지 않습니다. 기존 목록을 유지합니다.")
        group_id, group_name = raw_group_id.strip(), raw_name.strip()
        if not group_id or len(group_id) > 64 or not group_name or len(group_name) > 120 or any(ord(char) < 32 for char in group_id + group_name) or group_id in group_ids:
            raise BrokerError("해외 HTS 관심그룹 형식이 올바르지 않습니다. 기존 목록을 유지합니다.")
        group_ids.add(group_id)
        detail_body = getattr(_fetch_page("usa20201", "/api/us/watchlist", {"arn_grp_id": group_id}), "body", None)
        source_items = _confirmed_watchlist_rows(detail_body, list_key="nofj", failure="해외 HTS 관심종목 조회에 실패했습니다. 기존 목록을 유지합니다.")
        items = []
        for row in source_items:
            raw_code, raw_venue = row.get("cod2"), row.get("stex_tp")
            if not isinstance(raw_code, str) or not isinstance(raw_venue, str):
                raise BrokerError("해외 HTS 관심종목 식별자가 올바르지 않습니다. 기존 목록을 유지합니다.")
            code, venue = raw_code.strip().upper(), raw_venue.strip().upper()
            if not _US_CODE.fullmatch(code) or venue not in {"ND", "NY", "NA"}:
                raise BrokerError("해외 HTS 관심종목 식별자가 올바르지 않습니다. 기존 목록을 유지합니다.")
            identity = _identity(market="US", stk_cd=code, stex_tp=venue, listing_venue=_listing_for("US", venue))
            items.append({**identity, "stkNm": code})
        groups.append({"gcod": group_id, "name": group_name, "items": items})
    return groups


def _build_kr_index() -> tuple[list[dict], bool, str]:
    rows, complete, notes = [], True, []
    for market_type in ("0", "10"):
        page_rows, page_complete, reason = _fetch_rows("ka10099", "/api/dostk/stkinfo", {"mrkt_tp": market_type}, "list")
        complete &= page_complete
        if reason:
            notes.append(reason)
        mapped = [item for row in page_rows if (item := _instrument_from_row("KR", row, default_venue="KRX"))]
        omitted = len(page_rows) - len(mapped)
        if omitted:
            complete = False
            notes.append(f"omitted {omitted} unsupported KR symbols")
        rows.extend(mapped)
    return rows, complete, "; ".join(notes)


def _us_exact(code: str) -> list[dict]:
    cached = _exact_cache.get(code)
    if cached and time.monotonic() - cached[0] < 60:
        return cached[1]
    response = _fetch_page("usa10098", "/api/us/stkinfo", {"stk_cd": code})
    body = getattr(response, "body", {}) or {}
    rows = body.get("list", [])
    mapped = [item for row in rows if isinstance(row, dict) and (item := _instrument_from_row("US", row, default_venue="ND"))]
    _exact_cache[code] = (time.monotonic(), mapped)
    return mapped


def _build_us_index() -> tuple[list[dict], bool, str]:
    rows, complete, notes = [], True, []
    page_rows, page_complete, reason = _fetch_rows("usa10099", "/api/us/stkinfo", {"stex_tp": "%"}, "list")
    complete &= page_complete
    if reason:
        notes.append(reason)
    rows.extend(item for row in page_rows if (item := _instrument_from_row("US", row, default_venue="ND")))
    return rows, complete, "; ".join(notes)


def _start_index_load(market: str) -> None:
    key = (ENVIRONMENT, market)
    with _index_lock:
        cached = _index_cache.get(key)
        if cached and time.monotonic() - cached[0] < (3600 if cached[2] or cached[1] else 20):
            return
        if key in _index_loading:
            return
        _index_loading.add(key)

    def load() -> None:
        try:
            values, complete, note = _build_kr_index() if market == "KR" else _build_us_index()
            _index_cache[key] = (time.monotonic(), values, complete, note)
        except Exception:
            # Short negative caching stops a keypress storm after an outage.
            _index_cache[key] = (time.monotonic(), [], False, "symbol index unavailable")
        finally:
            with _index_lock:
                _index_loading.discard(key)

    Thread(target=load, name=f"kiwoom-index-{market.lower()}", daemon=True).start()


def _indexed(market: str) -> tuple[list[dict], bool, str]:
    key = (ENVIRONMENT, market)
    cached = _index_cache.get(key)
    if cached and time.monotonic() - cached[0] < (3600 if cached[2] or cached[1] else 20):
        return cached[1], cached[2], cached[3]
    _start_index_load(market)
    return [], False, f"{market} symbol index is loading in the background"


def search_symbols(query: str, market: str | None = None) -> dict:
    selected = market.upper() if market else None
    if selected not in {None, "KR", "US"}:
        raise BrokerError("market must be KR or US")
    if not KIWOOM_ENABLED:
        rows, complete, note = _fixture_search(query, selected)
        return {"results": rows, "complete": complete, "note": note}
    query = query.strip().upper()
    collections: list[tuple[list[dict], bool, str]] = []
    if selected in {None, "KR"}:
        collections.append(_indexed("KR"))
    if selected in {None, "US"}:
        exact = _us_exact(query) if _US_CODE.fullmatch(query) else []
        collections.append((exact, True, "")) if exact else collections.append(_indexed("US"))
    rows, complete, notes = [], True, []
    seen = set()
    for values, is_complete, note in collections:
        complete &= is_complete
        if note:
            notes.append(note)
        for row in values:
            if query and query not in row["stkCd"].upper() and query not in row["stkNm"].upper():
                continue
            key = _cache_key(row, "instrument")
            if key not in seen:
                rows.append(row)
                seen.add(key)
    if len(rows) > 20:
        complete = False
        notes.append("result limit is 20")
    return {"results": rows[:20], "complete": complete, "note": "; ".join(notes)}


def _bar(row: dict, *, daily: bool, market: str) -> dict | None:
    close = _number(row.get("cur_prc"), absolute=True, price=True)
    opening = _number(row.get("open_pric"), absolute=True, price=True)
    high = _number(row.get("high_pric"), absolute=True, price=True)
    low = _number(row.get("low_pric"), absolute=True, price=True)
    if None in {close, opening, high, low} or high < max(close, opening) or low > min(close, opening):
        return None
    if daily:
        timestamp = str(row.get("dt") or "").strip()
        time_format = "%Y%m%d"
    else:
        clock = str(row.get("cntr_tm") or row.get("dt") or "").strip()
        business_day = str(row.get("bus_dt") or "").strip()
        timestamp = f"{business_day}{clock}" if len(clock) == 6 and len(business_day) == 8 else clock
        time_format = "%Y%m%d%H%M%S"
    try:
        datetime.strptime(timestamp, time_format)
    except ValueError:
        return None
    volume_field = "trde_qty" if market == "KR" or not daily else "acc_trde_qty"
    volume = _number(row.get(volume_field), absolute=True)
    return {"t": timestamp, "o": opening, "h": high, "l": low, "c": close, "v": volume}


def _clean_bars(rows: list[dict], *, daily: bool, market: str) -> tuple[list[dict], int]:
    by_timestamp: dict[str, dict] = {}
    discarded = 0
    for row in rows:
        bar = _bar(row, daily=daily, market=market)
        if bar is None:
            discarded += 1
            continue
        if bar["t"] in by_timestamp:
            discarded += 1
        by_timestamp[bar["t"]] = bar
    return [by_timestamp[timestamp] for timestamp in sorted(by_timestamp)], discarded


def _fixture_chart(identity: dict, interval: str) -> dict:
    quote = _fixture_quote(identity, book=False)
    base = quote.get("last")
    if base is None:
        return {**identity, "stkNm": quote["stkNm"], "interval": interval, "bars": [], "note": "Fixture has no chart for this symbol.", "complete": True, "adjusted": True, "source": "fixture", "status": "missing", "receivedAt": _now(), "sourceTimestamp": None, "range": {"basis": "fixture"}}
    bars = []
    # Synthetic series only: enough history for zoom/MA60/RSI inspection.
    count = 180
    end = datetime(2026, 10, 23, 15, 30)
    dates = []
    cursor = end
    while len(dates) < count:
        if interval != "D" or cursor.weekday() < 5:
            dates.append(cursor)
        if interval == "Y":
            cursor = cursor.replace(year=cursor.year - 1, month=1, day=1)
        elif interval == "M":
            year, month = (cursor.year - 1, 12) if cursor.month == 1 else (cursor.year, cursor.month - 1)
            cursor = cursor.replace(year=year, month=month, day=1)
        else:
            cursor -= timedelta(days=7 if interval == "W" else 1) if interval in {"D", "W"} else timedelta(minutes=int(interval))
    dates.reverse()
    amplitude = base * (0.035 if interval in {"D", "W", "M", "Y"} else 0.003)
    previous = base - amplitude * 1.8
    for offset, stamp in enumerate(dates):
        close = base + (math.sin(offset * .105) * .65 + math.sin(offset * .43) * .14 + (offset - count + 1) / count * 1.5) * amplitude
        opening = previous + math.sin(offset * 1.73) * amplitude * .09
        high = max(opening, close) + (0.08 + abs(math.sin(offset * .81)) * .15) * amplitude
        low = min(opening, close) - (0.06 + abs(math.cos(offset * .67)) * .14) * amplitude
        quantum = 10 if identity["currency"] == "KRW" else .01
        opening, high, low, close = (round(round(value / quantum) * quantum, 2) for value in (opening, high, low, close))
        volume = float(round((quote.get("volume") or 100000) * (.12 + abs(math.sin(offset * .73)) * .65 + abs(close - opening) / amplitude)))
        bars.append({"t": stamp.strftime("%Y%m%d" if interval in {"D", "W", "M", "Y"} else "%Y%m%d%H%M%S"), "o": opening, "h": high, "l": low, "c": close, "v": volume})
        previous = close
    return {**identity, "stkNm": quote["stkNm"], "interval": interval, "bars": bars, "note": "Deterministic fixture chart; not broker data.", "complete": True, "adjusted": True, "source": "fixture", "status": "snapshot", "receivedAt": _now(), "sourceTimestamp": None, "range": {"basis": "fixture", "start": bars[0]["t"], "end": bars[-1]["t"]}}


@_shared_read
def get_chart(*, market: str, stk_cd: str, stex_tp: str | None = None, listing_venue: str | None = None, interval: str = "D") -> dict:
    if interval not in CHART_INTERVALS:
        raise BrokerError("unsupported chart interval")
    identity = _identity(market=market, stk_cd=stk_cd, stex_tp=stex_tp, listing_venue=listing_venue)
    key = _cache_key(identity, "chart", interval)
    cached = _chart_cache.get(key)
    if cached and time.monotonic() - cached[0] < 30:
        return dict(cached[1])
    if not KIWOOM_ENABLED:
        chart = _fixture_chart(identity, interval)
    else:
        daily = interval in {"D", "W", "M", "Y"}
        today = datetime.now(ZoneInfo("Asia/Seoul" if identity["market"] == "KR" else "America/New_York")).strftime("%Y%m%d")
        if identity["market"] == "KR":
            api_id, list_key = {
                "D": ("ka10081", "stk_dt_pole_chart_qry"),
                "W": ("ka10082", "stk_stk_pole_chart_qry"),
                "M": ("ka10083", "stk_mth_pole_chart_qry"),
                "Y": ("ka10094", "stk_yr_pole_chart_qry"),
            }.get(interval, ("ka10080", "stk_min_pole_chart_qry"))
            body = {"stk_cd": identity["stkCd"], "upd_stkpc_tp": "1"}
            if daily:
                body["base_dt"] = today
            else:
                body["tic_scope"] = interval
            path = "/api/dostk/chart"
        else:
            api_id = {"D": "usa06012", "W": "usa06013", "M": "usa06014", "Y": "usa06015"}.get(interval, "usa06011")
            body = {"stex_tp": identity["stexTp"], "stk_cd": identity["stkCd"], "strt_dt": today, "upd_stkpc_tp": "1", "exrt_appl_tp": "0"}
            if not daily:
                body["tic_scope"] = interval
            path, list_key = "/api/us/chart", "result_list"
        # Bound first paint to recent history; the response reports truncation.
        # Refresh only the newest pages and retain validated older bars.
        rows, complete, reason = _fetch_rows(api_id, path, body, list_key, max_pages=2 if cached else 4)
        bars, discarded = _clean_bars(rows, daily=daily, market=identity["market"])
        if cached and bars:
            previous = cached[1]
            old = {bar["t"]: bar for bar in previous["bars"]}
            fresh = {bar["t"]: bar for bar in bars}
            overlap = old.keys() & fresh.keys()
            # The formerly active last bar can legitimately change. Older
            # overlapping bars must agree before retaining adjusted history.
            prior_last = max(old, default="")
            revisions = [stamp for stamp in overlap if any(
                old[stamp].get(field) != fresh[stamp].get(field) for field in
                (("o",) if stamp == prior_last == max(fresh) else ("o", "h", "l", "c"))
            )]
            if not overlap or revisions:
                # A newer partial page cannot certify a missing interval or
                # the adjustment basis of untouched old bars. Replace instead
                # of drawing a fabricated continuous mixed-basis history.
                complete = bool(complete and not discarded)
                refresh_note = "Historical price revision detected; cached history replaced." if revisions else "No overlapping bars; cached history replaced without assuming continuity."
            else:
                old.update(fresh)
                bars = [old[t] for t in sorted(old)][-30000:]
                complete = bool(previous.get("complete", False) and complete and not discarded)
                refresh_note = "Latest pages refreshed; overlapping history validated and retained."
            reason = f"{refresh_note}; {reason}" if reason else refresh_note
        integrity = f"; discarded {discarded} invalid/duplicate bars" if discarded else ""
        chart = {**identity, "stkNm": identity["stkCd"], "interval": interval, "bars": bars, "note": (reason or "Provider chart snapshot; adjusted request=1.") + integrity, "complete": complete and not discarded and bool(bars), "adjusted": True, "source": "kiwoom", "status": "snapshot" if bars else "missing", "receivedAt": _now(), "sourceTimestamp": bars[-1]["t"] if bars else None, "range": {"baseDate": today, "adjustment": "1"}}
    bars = chart["bars"]
    chart["requestRange"] = chart.get("range")
    chart["range"] = {
        "basis": "fixture" if chart["source"] == "fixture" else "provider",
        "start": bars[0]["t"],
        "end": bars[-1]["t"],
    } if bars else None
    _remember(_chart_cache, key, chart, 64)
    return chart
