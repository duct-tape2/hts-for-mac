"""Local-only credentials for optional SEC and OpenDART public-data adapters.

This module intentionally does not read environment variables, browser state,
or Kiwoom credentials.  The DART key lives only in the macOS Keychain; the
non-secret SEC contact User-Agent is kept in a restrictive local settings
file.  Its router is inert until ``configure_auth_guard`` receives main's
existing local setup-capability guard.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from app.config import DATA_DIR, ENVIRONMENT


_SERVICE = "com.kiwoom.mac-readonly.company-data"
_DART_ACCOUNT = "dart-api-key-v1"
_SETTINGS_FILE = DATA_DIR / "company-data-settings-v1.json"
_BODY_LIMIT = 1024
_DART_KEY = re.compile(r"^[A-Za-z0-9]{40}$")
_CONTACT_EMAIL = re.compile(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class CompanyCredentialError(RuntimeError):
    """A secret-free local configuration error safe for HTTP responses."""


class CompanyCredentialStoreUnavailable(CompanyCredentialError):
    pass


def validate_sec_user_agent(value: object) -> str:
    text = str(value or "").strip()
    email = _CONTACT_EMAIL.search(text)
    label = text[:email.start()].strip(" ()<>-–—") if email else ""
    try:
        text.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError("SEC User-Agent must use an English (ASCII) application name and contact email") from exc
    if not 3 <= len(text) <= 180 or _CONTROL.search(text) or email is None or not label:
        raise ValueError("SEC User-Agent must use an English (ASCII) application name and contact email")
    return text


def validate_dart_api_key(value: object) -> str:
    key = str(value or "").strip()
    if not _DART_KEY.fullmatch(key):
        raise ValueError("DART API key must be a 40-character alphanumeric value")
    return key


class MacKeychainSecretStore:
    """Explicit macOS Keychain storage; no configurable keyring fallback."""

    def __init__(self, *, backend: Any | None = None) -> None:
        self._backend = backend

    def _keychain(self) -> Any:
        if self._backend is not None:
            return self._backend
        try:
            from keyring.backends.macOS import api

            return api
        except Exception as exc:
            raise CompanyCredentialStoreUnavailable("macOS Keychain is unavailable") from exc

    def read_dart_key(self) -> str | None:
        try:
            api = self._keychain()
            raw = api.get_password(_SERVICE, _DART_ACCOUNT) if self._backend is not None else api.find_generic_password(None, _SERVICE, _DART_ACCOUNT, not_found_ok=True)
        except Exception as exc:
            raise CompanyCredentialStoreUnavailable("macOS Keychain is unavailable") from exc
        if raw is None:
            return None
        try:
            return validate_dart_api_key(raw)
        except ValueError as exc:
            raise CompanyCredentialStoreUnavailable("stored DART key is unavailable") from exc

    def write_dart_key(self, value: str) -> None:
        key = validate_dart_api_key(value)
        try:
            api = self._keychain()
            if self._backend is not None:
                api.set_password(_SERVICE, _DART_ACCOUNT, key)
            else:
                self._native_replace(api, key)
        except CompanyCredentialError:
            raise
        except Exception as exc:
            raise CompanyCredentialStoreUnavailable("macOS Keychain is unavailable") from exc

    def delete_dart_key(self) -> None:
        try:
            api = self._keychain()
            if self._backend is not None:
                api.delete_password(_SERVICE, _DART_ACCOUNT)
            else:
                query = api.create_query(
                    kSecClass=api.k_("kSecClassGenericPassword"),
                    kSecAttrService=_SERVICE,
                    kSecAttrAccount=_DART_ACCOUNT,
                )
                try:
                    status = api.SecItemDelete(query)
                    if status not in {0, api.error.item_not_found}:
                        api.Error.raise_for_status(status)
                finally:
                    api._found.CFRelease(query)
        except Exception as exc:
            raise CompanyCredentialStoreUnavailable("macOS Keychain is unavailable") from exc

    @staticmethod
    def _native_replace(api: Any, value: str) -> None:
        """Update first, adding only when Keychain has no current item."""
        import ctypes

        update = api._sec.SecItemUpdate
        update.restype = api.OS_status
        update.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
        create_data = api._found.CFDataCreate
        create_data.restype = ctypes.c_void_p
        create_data.argtypes = (ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long)
        release = api._found.CFRelease
        release.restype = None
        release.argtypes = (ctypes.c_void_p,)
        encoded = value.encode("utf-8")
        raw = ctypes.create_string_buffer(encoded)
        data = create_data(None, raw, len(encoded))
        if not data:
            raise CompanyCredentialStoreUnavailable("macOS Keychain is unavailable")
        query = attributes = add = None
        try:
            query = api.create_query(kSecClass=api.k_("kSecClassGenericPassword"), kSecAttrService=_SERVICE, kSecAttrAccount=_DART_ACCOUNT)
            attributes = api.create_query(kSecValueData=ctypes.c_void_p(data))
            status = update(query, attributes)
            if status == api.error.item_not_found:
                add = api.create_query(
                    kSecClass=api.k_("kSecClassGenericPassword"), kSecAttrService=_SERVICE,
                    kSecAttrAccount=_DART_ACCOUNT, kSecValueData=ctypes.c_void_p(data),
                )
                api.Error.raise_for_status(api.SecItemAdd(add, None))
            else:
                api.Error.raise_for_status(status)
        finally:
            for item in (add, attributes, query, data):
                if item:
                    release(item)


class SecUserAgentSettings:
    """Atomic, owner-only persistence for a non-secret SEC contact string."""

    def __init__(self, path: Path = _SETTINGS_FILE) -> None:
        self._path = path

    def read(self) -> str | None:
        try:
            raw = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise CompanyCredentialStoreUnavailable("local SEC settings are unavailable") from exc
        try:
            if self._path.stat().st_mode & 0o077:
                raise ValueError
            payload = json.loads(raw)
            if not isinstance(payload, dict) or payload.get("version") != 1:
                raise ValueError
            value = payload.get("secUserAgent")
            return validate_sec_user_agent(value) if value else None
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise CompanyCredentialStoreUnavailable("local SEC settings are unavailable") from exc

    def write(self, value: str) -> None:
        user_agent = validate_sec_user_agent(value)
        try:
            self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(self._path.parent, 0o700)
            temporary = self._path.with_suffix(".tmp")
            with open(temporary, "w", encoding="utf-8") as handle:
                os.chmod(temporary, 0o600)
                json.dump({"version": 1, "secUserAgent": user_agent}, handle, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self._path)
            os.chmod(self._path, 0o600)
        except OSError as exc:
            raise CompanyCredentialStoreUnavailable("local SEC settings are unavailable") from exc


@dataclass(frozen=True)
class ProviderCredentials:
    sec_user_agent: str | None = field(repr=False)
    dart_api_key: str | None = field(repr=False)


class CompanyCredentialManager:
    def __init__(self, *, enabled: bool, keychain: MacKeychainSecretStore | None = None, settings: SecUserAgentSettings | None = None) -> None:
        self._enabled = enabled
        self._keychain = keychain or MacKeychainSecretStore()
        self._settings = settings or SecUserAgentSettings()
        self._lock = threading.RLock()

    def get_provider_credentials(self) -> ProviderCredentials:
        if not self._enabled:
            return ProviderCredentials(sec_user_agent=None, dart_api_key=None)
        with self._lock:
            # Optional providers must fail independently: a locked Keychain
            # must not disable SEC, and a local settings issue must not hide
            # a separately stored DART key.
            try:
                sec_user_agent = self._settings.read()
            except CompanyCredentialStoreUnavailable:
                sec_user_agent = None
            try:
                dart_api_key = self._keychain.read_dart_key()
            except CompanyCredentialStoreUnavailable:
                dart_api_key = None
            return ProviderCredentials(sec_user_agent=sec_user_agent, dart_api_key=dart_api_key)

    def public_status(self) -> dict[str, object]:
        if not self._enabled:
            return {
                "environment": "fixture", "secUserAgentConfigured": False, "dartKeyConfigured": False,
                "secSettingsStorage": "none", "dartStorage": "none",
            }
        with self._lock:
            try:
                sec_user_agent, sec_storage = self._settings.read(), "local"
            except CompanyCredentialStoreUnavailable:
                sec_user_agent, sec_storage = None, "unavailable"
            try:
                dart_key, dart_storage = self._keychain.read_dart_key(), "keychain"
            except CompanyCredentialStoreUnavailable:
                dart_key, dart_storage = None, "unavailable"
            return {
                "environment": ENVIRONMENT,
                "secUserAgentConfigured": sec_user_agent is not None,
                "dartKeyConfigured": dart_key is not None,
                "secSettingsStorage": sec_storage if sec_user_agent is not None or sec_storage == "unavailable" else "none",
                "dartStorage": dart_storage if dart_key is not None or dart_storage == "unavailable" else "none",
            }

    def save_sec_user_agent(self, value: str) -> dict[str, object]:
        if not self._enabled:
            raise CompanyCredentialError("provider credentials are disabled in fixture mode")
        with self._lock:
            self._settings.write(value)
            return self.public_status()

    def save_dart_key(self, value: str) -> dict[str, object]:
        if not self._enabled:
            raise CompanyCredentialError("provider credentials are disabled in fixture mode")
        with self._lock:
            self._keychain.write_dart_key(value)
            return self.public_status()

    def delete_dart_key(self) -> dict[str, object]:
        if not self._enabled:
            raise CompanyCredentialError("provider credentials are disabled in fixture mode")
        with self._lock:
            self._keychain.delete_dart_key()
            return self.public_status()


credential_manager = CompanyCredentialManager(enabled=ENVIRONMENT != "fixture")


def get_provider_credentials() -> ProviderCredentials:
    """Private root integration hook; never serialize this return value."""
    return credential_manager.get_provider_credentials()


AuthGuard = Callable[..., None]
_auth_guard: AuthGuard | None = None
router = APIRouter(prefix="/api/company-credentials", tags=["company-data-credentials"])


def configure_auth_guard(guard: AuthGuard) -> None:
    """Root must pass its existing `_auth_request` function before inclusion."""
    global _auth_guard
    _auth_guard = guard


def _authorize(request: Request, *, mutation: bool) -> None:
    if _auth_guard is None:
        raise HTTPException(503, "company credential authorization is not configured")
    _auth_guard(request, mutation=mutation)


def _no_store(payload: dict[str, object]) -> JSONResponse:
    return JSONResponse(payload, headers={"Cache-Control": "no-store", "Pragma": "no-cache", "Vary": "Origin"})


async def _body(request: Request, *, keys: set[str]) -> dict[str, object]:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > _BODY_LIMIT:
            raise HTTPException(400, "invalid company credential request")
        chunks.append(chunk)
    try:
        payload = json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "invalid company credential request") from exc
    if not isinstance(payload, dict) or set(payload) != keys:
        raise HTTPException(400, "invalid company credential request")
    return payload


@router.get("/status")
async def status(request: Request) -> JSONResponse:
    _authorize(request, mutation=False)
    return _no_store(await asyncio.to_thread(credential_manager.public_status))


@router.post("/sec-user-agent")
async def save_sec_user_agent(request: Request) -> JSONResponse:
    _authorize(request, mutation=True)
    body = await _body(request, keys={"secUserAgent"})
    try:
        value = body["secUserAgent"]
        if not isinstance(value, str):
            raise ValueError
        return _no_store(await asyncio.to_thread(credential_manager.save_sec_user_agent, value))
    except (CompanyCredentialError, ValueError):
        raise HTTPException(400, "company credential update failed") from None


@router.post("/dart-key")
async def save_dart_key(request: Request) -> JSONResponse:
    _authorize(request, mutation=True)
    body = await _body(request, keys={"dartApiKey"})
    try:
        value = body["dartApiKey"]
        if not isinstance(value, str):
            raise ValueError
        return _no_store(await asyncio.to_thread(credential_manager.save_dart_key, value))
    except (CompanyCredentialError, ValueError):
        raise HTTPException(400, "company credential update failed") from None


@router.post("/dart-key/delete")
async def delete_dart_key(request: Request) -> JSONResponse:
    _authorize(request, mutation=True)
    await _body(request, keys=set())
    try:
        return _no_store(await asyncio.to_thread(credential_manager.delete_dart_key))
    except CompanyCredentialError:
        raise HTTPException(400, "company credential update failed") from None
