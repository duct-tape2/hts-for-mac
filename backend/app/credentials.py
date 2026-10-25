"""Application-owned, memory-backed Kiwoom credential lifecycle.

The official SDK continues to issue tokens and build clients.  This module
only chooses the SDK's in-memory inputs and makes the durable state atomic:
one macOS Keychain JSON value per runtime mode.  It deliberately never uses a
plaintext file as an application credential fallback.
"""
from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Any, Callable

from kiwoom import KiwoomAuth
from kiwoom.core.errors import DeviceAuthenticationError, InvalidCredentialsError, ModeMismatchError
from kiwoom.core.secrets import CredentialSet, EnvSecretProvider, StaticSecretProvider
from kiwoom.core.token_store import FileTokenStore, MemoryTokenStore, TokenRecord


KST = timezone(timedelta(hours=9))
REFRESH_BUFFER_SECONDS = 600
WAKE_SECONDS = 30.0
RETRY_INITIAL_SECONDS = 1.0
RETRY_MAX_SECONDS = 30.0
_SERVICE_PREFIX = "com.kiwoom.mac-readonly.credentials"
_ACCOUNT = "credential-v1"


class CredentialError(RuntimeError):
    """A bounded credential problem that is safe to present locally."""


class CredentialsRequired(CredentialError):
    pass


class CredentialValidationFailed(CredentialError):
    pass


class CredentialStoreUnavailable(CredentialError):
    pass


class CredentialRetryLater(CredentialError):
    pass


@dataclass(frozen=True)
class StoredCredential:
    """The complete application record. Secret fields are never repr'd."""

    app_key: str = field(repr=False)
    app_secret: str = field(repr=False)
    registered_expires_on: date
    token: TokenRecord | None = field(default=None, repr=False)


class KeychainCredentialStore:
    """Explicit macOS Keychain adapter using one replaceable JSON item."""

    def __init__(self, mode: str, *, backend: Any | None = None) -> None:
        if mode not in {"real", "demo"}:
            raise ValueError("mode must be real or demo")
        self.mode = mode
        self._backend = backend

    @property
    def service_name(self) -> str:
        return f"{_SERVICE_PREFIX}.{self.mode}"

    def _keychain(self) -> Any:
        if self._backend is not None:
            return self._backend
        try:
            # Importing the macOS Security binding explicitly avoids a
            # user-configured non-Keychain keyring backend.
            from keyring.backends.macOS import api

            return api
        except Exception as exc:  # Never surface backend/provider text.
            raise CredentialStoreUnavailable("macOS Keychain is unavailable") from exc

    def read(self) -> StoredCredential | None:
        try:
            backend = self._keychain()
            raw = backend.get_password(self.service_name, _ACCOUNT) if self._backend is not None else backend.find_generic_password(None, self.service_name, _ACCOUNT, not_found_ok=True)
        except Exception as exc:
            raise CredentialStoreUnavailable("macOS Keychain is unavailable") from exc
        if raw is None:
            return None
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict) or payload.get("version") != 1 or payload.get("mode") != self.mode:
                raise ValueError
            app_key, app_secret = payload["appKey"], payload["appSecret"]
            expires = date.fromisoformat(payload["registeredExpiresOn"])
            if not all(isinstance(value, str) and value for value in (app_key, app_secret)):
                raise ValueError
            token = _token_from_payload(payload.get("token"), mode=self.mode)
            return StoredCredential(app_key=app_key, app_secret=app_secret, registered_expires_on=expires, token=token)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise CredentialStoreUnavailable("stored credentials are unavailable") from exc

    def write(self, record: StoredCredential) -> None:
        self._write(record, create_only=False)

    def create(self, record: StoredCredential) -> None:
        """Atomically fail if another process already registered this item."""
        self._write(record, create_only=True)

    def _write(self, record: StoredCredential, *, create_only: bool) -> None:
        payload: dict[str, Any] = {
            "version": 1,
            "mode": self.mode,
            "appKey": record.app_key,
            "appSecret": record.app_secret,
            "registeredExpiresOn": record.registered_expires_on.isoformat(),
        }
        if record.token is not None:
            payload["token"] = _token_payload(record.token)
        try:
            backend = self._keychain()
            serialized = json.dumps(payload, separators=(",", ":"))
            if self._backend is not None:
                # Test doubles must model replacement as one call too.
                if create_only:
                    backend.add_password(self.service_name, _ACCOUNT, serialized)
                else:
                    backend.set_password(self.service_name, _ACCOUNT, serialized)
            else:
                self._native_replace(backend, serialized, create_only=create_only)
        except Exception as exc:
            raise CredentialStoreUnavailable("macOS Keychain is unavailable") from exc

    def _native_replace(self, api: Any, password: str, *, create_only: bool = False) -> None:
        """SecItemUpdate existing value, then add only when it is absent.

        keyring's convenience ``set_generic_password`` deletes first, making
        a failed add lose the active credentials. The Security framework
        update below retains the old value whenever the replacement fails.
        """
        import ctypes

        update = api._sec.SecItemUpdate
        update.restype = api.OS_status
        update.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
        cf_data_create = api._found.CFDataCreate
        cf_data_create.restype = ctypes.c_void_p
        cf_data_create.argtypes = (ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long)
        release = api._found.CFRelease
        release.restype = None
        release.argtypes = (ctypes.c_void_p,)
        encoded = password.encode("utf-8")
        raw = ctypes.create_string_buffer(encoded)
        value_data = cf_data_create(None, raw, len(encoded))
        if not value_data:
            raise CredentialStoreUnavailable("macOS Keychain is unavailable")
        query = attributes = add = None
        try:
            query = api.create_query(
                kSecClass=api.k_("kSecClassGenericPassword"),
                kSecAttrService=self.service_name,
                kSecAttrAccount=_ACCOUNT,
            )
            attributes = api.create_query(kSecValueData=ctypes.c_void_p(value_data))
            status = api.error.item_not_found if create_only else update(query, attributes)
            if status == api.error.item_not_found:
                add = api.create_query(
                    kSecClass=api.k_("kSecClassGenericPassword"),
                    kSecAttrService=self.service_name,
                    kSecAttrAccount=_ACCOUNT,
                    kSecValueData=ctypes.c_void_p(value_data),
                )
                api.Error.raise_for_status(api.SecItemAdd(add, None))
                return
            api.Error.raise_for_status(status)
        finally:
            for value in (add, attributes, query, value_data):
                if value:
                    release(value)


def _token_payload(token: TokenRecord) -> dict[str, str]:
    return {
        "accessToken": token.access_token,
        "tokenType": token.token_type,
        "expiresAt": token.expires_at.astimezone(UTC).isoformat(),
        "credentialFingerprint": token.credential_fingerprint or "",
        "savedAt": (token.saved_at or datetime.now(UTC)).astimezone(UTC).isoformat(),
    }


def _token_from_payload(payload: object, *, mode: str) -> TokenRecord | None:
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise ValueError
    access_token = payload.get("accessToken")
    token_type = payload.get("tokenType")
    fingerprint = payload.get("credentialFingerprint")
    expires = payload.get("expiresAt")
    saved = payload.get("savedAt")
    if not all(isinstance(value, str) and value for value in (access_token, token_type, fingerprint, expires, saved)):
        raise ValueError
    expires_at = datetime.fromisoformat(expires).astimezone(UTC)
    saved_at = datetime.fromisoformat(saved).astimezone(UTC)
    if token_type.lower() != "bearer":
        raise ValueError
    return TokenRecord(
        access_token=access_token,
        token_type="bearer",
        expires_at=expires_at,
        mode=mode,  # type: ignore[arg-type]
        credential_fingerprint=fingerprint,
        saved_at=saved_at,
    )


class _ManagedAuth(KiwoomAuth):
    """SDK-compatible auth whose token operations are manager singleflight."""

    def __init__(self, manager: "CredentialManager") -> None:
        # Base fields (especially ``mode``) are retained for SDK clients. The
        # provider/store are never used by the overridden token operations.
        super().__init__(
            mode=manager.mode,
            secret_provider=StaticSecretProvider("managed", "managed", source="managed"),
            token_store=MemoryTokenStore(),
            refresh_buffer_seconds=REFRESH_BUFFER_SECONDS,
        )
        self._manager = manager

    def get_access_token(self) -> str:
        return self._manager.get_access_token()

    def refresh_access_token(self) -> str:
        return self._manager.refresh_access_token()

    def recover_from_auth_failure(self) -> str:
        return self._manager.recover_from_auth_failure()

    def clear_token(self) -> bool:
        # The SDK invokes this before its one retry. Clearing a shared token
        # would make parallel in-flight requests stampede, so recovery owns it.
        return False


class CredentialManager:
    """Process-wide SDK auth facade with bounded retry and refresh behavior."""

    def __init__(
        self,
        mode: str,
        *,
        enabled: bool,
        store: KeychainCredentialStore | Any | None = None,
        now: Callable[[], datetime] | None = None,
        legacy_token_loader: Callable[[str], TokenRecord | None] | None = None,
    ) -> None:
        if mode not in {"real", "demo"}:
            raise ValueError("mode must be real or demo")
        self.mode = mode
        self.enabled = enabled
        self._store = store or KeychainCredentialStore(mode)
        self._now = now or (lambda: datetime.now(UTC))
        self._legacy_token_loader = legacy_token_loader or _legacy_token
        self._condition = threading.Condition(threading.RLock())
        # Token issue/persist/swap and explicit replacement are one mutation
        # lane. The condition remains separate so token readers never wait on
        # network I/O while holding the state lock.
        self._operation_lock = threading.Lock()
        self._tokens = MemoryTokenStore()
        self._record: StoredCredential | None = None
        self._loaded = False
        self._storage = "none"
        self._storage_retry_at: datetime | None = None
        self._storage_retry_delay = RETRY_INITIAL_SECONDS
        self._refreshing = False
        self._generation = 0
        self._retry_delay = RETRY_INITIAL_SECONDS
        self._next_retry_at: datetime | None = None
        self._last_refresh_at: datetime | None = None
        self._last_error = ""
        self._credentials_invalid = False
        self._authorizer: Callable[[], None] | None = None
        self._on_generation: Callable[[int], None] | None = None
        self._local = threading.local()
        self._stop_event = threading.Event()
        self._wake_thread: threading.Thread | None = None
        self._managed_auth = _ManagedAuth(self)

    def set_authorizer(self, authorizer: Callable[[], None]) -> None:
        self._authorizer = authorizer

    def set_generation_listener(self, listener: Callable[[int], None]) -> None:
        self._on_generation = listener

    def sdk_auth(self) -> KiwoomAuth:
        """Return the one auth object shared by REST and WebSocket clients."""
        return self._managed_auth

    def websocket_auth_snapshot(self) -> tuple[str, int]:
        """Prewarm auth off an event loop and pin one WebSocket LOGIN token."""
        token = self.get_access_token()
        # ``_return_token_locked`` stamps the generation under the same lock
        # that chose the token. Reading a later global generation here would
        # pair an old bearer with a newer generation during a concurrent swap.
        return token, int(getattr(self._local, "generation"))

    def recover_websocket_auth(self, observed_generation: int) -> tuple[str, int]:
        """Perform the SDK's one auth recovery off the stream event loop."""
        token = self._obtain_token(force=True, observed_generation=observed_generation)
        return token, int(getattr(self._local, "generation"))

    def start(self) -> None:
        """Load local state and start the bounded background refresh check."""
        if not self.enabled:
            return
        with self._condition:
            self._load_locked()
            if self._wake_thread is not None and self._wake_thread.is_alive():
                return
            self._stop_event.clear()
            self._wake_thread = threading.Thread(target=self._wake_loop, name="kiwoom-auth-refresh", daemon=True)
            self._wake_thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        thread = self._wake_thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)

    def _wake_loop(self) -> None:
        while not self._stop_event.wait(WAKE_SECONDS):
            try:
                self.refresh_if_due()
            except CredentialError:
                # Status records a bounded retry/needs-credentials result.
                pass

    def refresh_if_due(self) -> None:
        """Refresh only an existing token nearing expiry; do not eagerly issue."""
        with self._condition:
            self._load_locked()
            token = self._token_locked()
            if token is None or not self._needs_refresh(token, self._utc_now()):
                return
        self._obtain_token(force=False)

    def get_access_token(self) -> str:
        return self._obtain_token(force=False)

    def refresh_access_token(self) -> str:
        return self._obtain_token(force=True)

    def recover_from_auth_failure(self) -> str:
        observed = getattr(self._local, "generation", None)
        return self._obtain_token(force=True, observed_generation=observed)

    def register(self, *, app_key: str, app_secret: str, registered_expires_on: date) -> dict[str, Any]:
        return self._register(app_key=app_key, app_secret=app_secret, registered_expires_on=registered_expires_on)

    def register_from_launcher(self, *, registered_expires_on: date) -> dict[str, Any]:
        """Explicit local save; credentials remain inside this backend process."""
        return self._register(app_key="", app_secret="", registered_expires_on=registered_expires_on, from_launcher=True)

    def _register(self, *, app_key: str, app_secret: str, registered_expires_on: date, from_launcher: bool = False) -> dict[str, Any]:
        """Validate with a throwaway SDK auth, atomically persist, then swap."""
        if not self.enabled:
            raise CredentialsRequired("broker credentials are unavailable in fixture mode")
        if registered_expires_on < self._utc_now().astimezone(KST).date():
            raise CredentialValidationFailed("registered expiry date is invalid")
        with self._operation_lock:
            if from_launcher:
                with self._condition:
                    self._load_locked()
                    if self._record is not None or self._storage == "unavailable":
                        raise CredentialValidationFailed("launcher migration is unavailable")
                    current = self._credentials_locked()
                    if current is None:
                        raise CredentialsRequired("launcher credentials are unavailable")
                    app_key, app_secret = current.appkey, current.secretkey
            _validate_credential_text(app_key, app_secret)
            # Policy is explicitly checked before constructing the temporary
            # auth (and therefore before its first possible network operation).
            self._authorize()
            token = self._issue_with_credentials(app_key, app_secret)
            candidate = StoredCredential(app_key=app_key, app_secret=app_secret, registered_expires_on=registered_expires_on, token=token)
            # Do not alter active state until the new complete Keychain write
            # succeeds. A failed replacement remains entirely local.
            if from_launcher:
                self._store.create(candidate)
            else:
                self._store.write(candidate)
            with self._condition:
                self._record = candidate
                self._storage = "keychain"
                self._storage_retry_at = None
                self._storage_retry_delay = RETRY_INITIAL_SECONDS
                self._loaded = True
                self._tokens = MemoryTokenStore()
                self._tokens.save(token)
                self._last_refresh_at = token.saved_at or self._utc_now()
                self._last_error = ""
                self._credentials_invalid = False
                self._refreshing = False
                self._next_retry_at = None
                self._retry_delay = RETRY_INITIAL_SECONDS
                self._generation += 1
                generation = self._generation
                self._condition.notify_all()
        self._notify_generation(generation)
        return self.public_status()

    def public_status(self) -> dict[str, Any]:
        with self._condition:
            self._load_locked()
            now = self._utc_now()
            if not self.enabled:
                return {
                    "environment": "fixture",
                    "stored": False,
                    "canSaveLauncher": False,
                    "storage": "none",
                    "status": "ready",
                    "registeredExpiresOn": None,
                    "remindOn": None,
                    "renewalDue": False,
                    "registrationExpired": False,
                    "tokenExpiresAt": None,
                    "lastRefreshAt": None,
                    "nextRetryAt": None,
                    "message": "테스트 데이터 모드입니다.",
                }
            token = self._token_locked()
            registered_on = self._record.registered_expires_on if self._record else None
            today = now.astimezone(KST).date()
            valid = token is not None and self._not_expired(token, now)
            if self._credentials_invalid:
                state, message = "needs_credentials", "API 키를 다시 확인해 주세요."
            elif self._refreshing:
                state, message = "refreshing", "저장된 키로 토큰을 자동 갱신합니다."
            elif self._next_retry_at is not None and now < self._next_retry_at:
                state, message = "retrying", "연결을 자동으로 다시 시도합니다."
            elif valid:
                state, message = "ready", ("현재 토큰 사용 중 · 키체인을 잠금 해제한 뒤 다시 시도하세요." if self._storage == "unavailable" else ("저장된 키로 토큰을 자동 갱신합니다." if self._record else "현재 토큰 사용 중 · 자동 갱신하려면 키를 등록하세요."))
            elif self._storage == "unavailable":
                state, message = "error", "키체인을 잠금 해제한 뒤 다시 시도하세요."
            elif self._last_error == "refresh_failed":
                # A provider/network refresh failure says nothing about the
                # saved pair's validity. Keep the user from replacing good
                # credentials while the next bounded request retries.
                state, message = "error", "토큰 갱신에 일시적으로 실패했습니다. 저장된 키는 유지되며 다음 조회에서 자동 재시도합니다."
            elif self._record is not None:
                # Cold start and an expired idle token are expected states:
                # get_access_token() will issue a fresh token on demand.
                state, message = "ready", "저장된 키로 첫 조회 시 토큰을 자동 갱신합니다."
            elif self._credentials_locked() is None:
                state, message = "needs_credentials", "API 키를 등록해 주세요."
            else:
                state, message = "needs_credentials", "API 키를 등록해 주세요."
            return {
                "environment": self.mode if self.enabled else "fixture",
                "stored": self._record is not None,
                "canSaveLauncher": self._record is None and self._storage != "unavailable" and self._credentials_locked() is not None,
                "storage": self._storage if self.enabled else "none",
                "status": state,
                "registeredExpiresOn": registered_on.isoformat() if registered_on else None,
                "remindOn": (registered_on - timedelta(days=7)).isoformat() if registered_on else None,
                "renewalDue": bool(registered_on and today >= registered_on - timedelta(days=7)),
                "registrationExpired": bool(registered_on and today > registered_on),
                "tokenExpiresAt": _iso(token.expires_at) if token else None,
                "lastRefreshAt": _iso(self._last_refresh_at),
                "nextRetryAt": _iso(self._next_retry_at),
                "message": message,
            }

    def _obtain_token(self, *, force: bool, observed_generation: int | None = None) -> str:
        if not self.enabled:
            raise CredentialsRequired("broker credentials are unavailable in fixture mode")
        while True:
            with self._condition:
                self._load_locked()
                now = self._utc_now()
                current = self._token_locked()
                valid = current is not None and self._not_expired(current, now)
                reusable = valid and not self._needs_refresh(current, now)
                # An SDK 401 for a token issued before another thread rotated
                # is already recovered. This prevents a second 401 cascade.
                if force and observed_generation is not None and observed_generation != self._generation and valid:
                    return self._return_token_locked(current)
                if reusable and not force:
                    return self._return_token_locked(current)
                if self._credentials_invalid:
                    if valid and not force:
                        return self._return_token_locked(current)
                    raise CredentialsRequired("credentials must be replaced")
                credentials = self._credentials_locked()
                if credentials is None:
                    if valid and not force:
                        return self._return_token_locked(current)
                    self._last_error = "credentials_required"
                    raise CredentialsRequired("credentials are required")
                if self._refreshing:
                    self._condition.wait()
                    continue
                if self._next_retry_at is not None and now < self._next_retry_at:
                    if valid and not force:
                        return self._return_token_locked(current)
                    raise CredentialRetryLater("refresh is retrying")
                self._refreshing = True
                previous = current if valid else None
                source_generation = self._generation
                break

        restart = False
        generation = None
        result = None
        with self._operation_lock:
            with self._condition:
                # A registration or another refresh won the mutation lane. Do
                # not let an older operation write its stale record back.
                if self._generation != source_generation:
                    self._refreshing = False
                    self._condition.notify_all()
                    current = self._token_locked()
                    if current is not None and self._not_expired(current, self._utc_now()):
                        return self._return_token_locked(current)
                    restart = True
                else:
                    credentials = self._credentials_locked()
                    record = self._record
                    if credentials is None or self._credentials_invalid:
                        self._refreshing = False
                        self._condition.notify_all()
                        raise CredentialsRequired("credentials are required")
            if restart:
                pass
            else:
                try:
                    self._authorize()
                    issued = self._issue_with_credentials(credentials.appkey, credentials.secretkey)
                    # Persist before memory activation when Keychain owns the
                    # pair; this entire issue/write/commit lane is serialized.
                    if record is not None:
                        self._store.write(replace(record, token=issued))
                except Exception as exc:
                    issue_error = exc
                else:
                    issue_error = None

                if issue_error is not None:
                    with self._condition:
                        self._refreshing = False
                        self._last_error = "refresh_failed"
                        invalid = isinstance(issue_error, (InvalidCredentialsError, ModeMismatchError, DeviceAuthenticationError))
                        self._credentials_invalid = invalid
                        if isinstance(issue_error, CredentialStoreUnavailable):
                            self._storage = "unavailable"
                            self._storage_retry_at = self._utc_now() + timedelta(seconds=self._storage_retry_delay)
                            self._storage_retry_delay = min(RETRY_MAX_SECONDS, self._storage_retry_delay * 2.0)
                        if invalid:
                            self._next_retry_at = None
                        else:
                            self._next_retry_at = self._utc_now() + timedelta(seconds=self._retry_delay)
                            self._retry_delay = min(RETRY_MAX_SECONDS, self._retry_delay * 2.0)
                        self._condition.notify_all()
                        # An explicit SDK 401 recovery must not retry the bearer
                        # token that was just rejected. A proactive transient
                        # refresh may keep a token until actual expiry.
                        if not force and previous is not None and self._not_expired(previous, self._utc_now()):
                            return self._return_token_locked(previous)
                    if isinstance(issue_error, CredentialError):
                        raise issue_error
                    raise CredentialValidationFailed("credential refresh failed") from issue_error

                with self._condition:
                    self._refreshing = False
                    if self._record is not None:
                        self._record = replace(self._record, token=issued)
                    self._tokens = MemoryTokenStore()
                    self._tokens.save(issued)
                    self._last_refresh_at = issued.saved_at or self._utc_now()
                    self._last_error = ""
                    self._next_retry_at = None
                    self._retry_delay = RETRY_INITIAL_SECONDS
                    self._generation += 1
                    generation = self._generation
                    self._condition.notify_all()
                    result = self._return_token_locked(issued)
        if restart:
            return self._obtain_token(force=force, observed_generation=observed_generation)
        assert generation is not None and result is not None
        self._notify_generation(generation)
        return result

    def _issue_with_credentials(self, app_key: str, app_secret: str) -> TokenRecord:
        temporary_store = MemoryTokenStore()
        provider = StaticSecretProvider(app_key, app_secret, source="request")
        temporary_auth = KiwoomAuth(
            mode=self.mode,
            secret_provider=provider,
            token_store=temporary_store,
            refresh_buffer_seconds=REFRESH_BUFFER_SECONDS,
        )
        # Calling the official SDK auth is the throwaway validation request.
        temporary_auth.get_access_token()
        token = temporary_store.peek(self.mode)
        if token is None or not self._not_expired(token, self._utc_now()):
            raise CredentialValidationFailed("token validation failed")
        return token

    def _load_locked(self) -> None:
        if not self.enabled:
            return
        now = self._utc_now()
        if self._loaded and self._storage != "unavailable":
            return
        if self._loaded and self._storage_retry_at is not None and now < self._storage_retry_at:
            return
        self._loaded = True
        readable = True
        try:
            record = self._store.read()
        except CredentialStoreUnavailable:
            readable = False
            self._storage = "unavailable"
            self._storage_retry_at = now + timedelta(seconds=self._storage_retry_delay)
            self._storage_retry_delay = min(RETRY_MAX_SECONDS, self._storage_retry_delay * 2.0)
            record = None
        if record is not None:
            self._record = record
            self._storage = "keychain"
            self._storage_retry_at = None
            self._storage_retry_delay = RETRY_INITIAL_SECONDS
            if record.token is not None:
                self._tokens.save(record.token)
                self._last_refresh_at = record.token.saved_at
            return
        if readable:
            self._storage = "none"
            self._storage_retry_at = None
            self._storage_retry_delay = RETRY_INITIAL_SECONDS
        # Migration is runtime-only: peek never mutates an SDK token file, and
        # the record never gets copied into Keychain without an explicit save.
        try:
            legacy = self._legacy_token_loader(self.mode)
        except Exception:
            legacy = None
        if legacy is not None and self._not_expired(legacy, self._utc_now()):
            self._tokens.save(legacy)
            self._last_refresh_at = legacy.saved_at

    def _credentials_locked(self) -> CredentialSet | None:
        if self._record is not None:
            return CredentialSet(appkey=self._record.app_key, secretkey=self._record.app_secret, source="keychain")
        # Legacy launcher credentials are volatile compatibility only. They
        # are lower precedence than an app-owned Keychain record and never
        # receive a write unless the explicit local save is requested.
        try:
            return EnvSecretProvider().get_credentials(self.mode)  # type: ignore[arg-type]
        except Exception:
            return None

    def _token_locked(self) -> TokenRecord | None:
        return self._tokens.peek(self.mode)  # type: ignore[arg-type]

    def _authorize(self) -> None:
        if self._authorizer is None:
            raise CredentialValidationFailed("broker policy is unavailable")
        self._authorizer()

    def _return_token_locked(self, token: TokenRecord) -> str:
        self._local.generation = self._generation
        return token.access_token

    def _notify_generation(self, generation: int) -> None:
        listener = self._on_generation
        if listener is not None:
            try:
                listener(generation)
            except Exception:
                # A stream wake failure never invalidates a successfully saved
                # HTTP credential rotation. The stream reconnect loop retries.
                pass

    def _utc_now(self) -> datetime:
        now = self._now()
        return now.replace(tzinfo=UTC) if now.tzinfo is None else now.astimezone(UTC)

    @staticmethod
    def _not_expired(token: TokenRecord, now: datetime) -> bool:
        return now < token.expires_at.astimezone(UTC)

    @staticmethod
    def _needs_refresh(token: TokenRecord, now: datetime) -> bool:
        return now >= token.expires_at.astimezone(UTC) - timedelta(seconds=REFRESH_BUFFER_SECONDS)


def _legacy_token(mode: str) -> TokenRecord | None:
    # ``peek`` is deliberately non-destructive. Never use load/clear against
    # an SDK cache the user may still rely on outside this application.
    return FileTokenStore().peek(mode)  # type: ignore[arg-type]


def _validate_credential_text(app_key: str, app_secret: str) -> None:
    for value in (app_key, app_secret):
        if not isinstance(value, str) or not 8 <= len(value) <= 256 or value != value.strip() or any(ord(char) < 33 or ord(char) == 127 for char in value):
            raise CredentialValidationFailed("credential format is invalid")


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


credential_manager = CredentialManager(
    mode=(os.getenv("KIWOOM_MODE") or "real").strip().lower() if (os.getenv("KIWOOM_MODE") or "real").strip().lower() in {"real", "demo"} else "real",
    enabled=(os.getenv("KIWOOM_ENABLED") or "").strip().lower() in {"1", "true", "yes", "on"},
)
