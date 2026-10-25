from __future__ import annotations

import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import company_credentials as company


TEST_KEY = "a" * 40
TEST_AGENT = "Kiwoom Mac Trading support@example.invalid"


class Keychain:
    def __init__(self):
        self.values: dict[tuple[str, str], str] = {}
        self.reads = self.writes = self.deletes = 0

    def get_password(self, service: str, account: str):
        self.reads += 1
        return self.values.get((service, account))

    def set_password(self, service: str, account: str, value: str):
        self.writes += 1
        self.values[(service, account)] = value

    def delete_password(self, service: str, account: str):
        self.deletes += 1
        self.values.pop((service, account), None)


def manager(tmp_path, *, enabled=True, keychain=None):
    return company.CompanyCredentialManager(
        enabled=enabled,
        keychain=company.MacKeychainSecretStore(backend=keychain or Keychain()),
        settings=company.SecUserAgentSettings(tmp_path / "settings" / "company-data-settings.json"),
    )


def test_secure_persistence_and_private_injection_never_expose_values(tmp_path):
    keychain = Keychain()
    credentials = manager(tmp_path, keychain=keychain)

    before = credentials.public_status()
    assert before["secUserAgentConfigured"] is False and before["dartKeyConfigured"] is False
    credentials.save_sec_user_agent(TEST_AGENT)
    credentials.save_dart_key(TEST_KEY)
    status = credentials.public_status()
    injected = credentials.get_provider_credentials()
    settings_path = tmp_path / "settings" / "company-data-settings.json"

    assert status == {
        "environment": "fixture", "secUserAgentConfigured": True, "dartKeyConfigured": True,
        "secSettingsStorage": "local", "dartStorage": "keychain",
    }
    assert injected.sec_user_agent == TEST_AGENT and injected.dart_api_key == TEST_KEY
    assert TEST_KEY not in str(status) and TEST_AGENT not in str(status) and TEST_KEY not in repr(injected)
    assert os.stat(settings_path).st_mode & 0o777 == 0o600
    assert os.stat(settings_path.parent).st_mode & 0o777 == 0o700

    deleted = credentials.delete_dart_key()
    assert deleted["dartKeyConfigured"] is False and keychain.deletes == 1


def test_fixture_manager_never_reads_keychain_or_local_settings(tmp_path):
    class ExplodingKeychain(Keychain):
        def get_password(self, *_args):
            raise AssertionError("fixture must not read Keychain")

    class ExplodingSettings(company.SecUserAgentSettings):
        def read(self):
            raise AssertionError("fixture must not read settings")

    credentials = company.CompanyCredentialManager(
        enabled=False,
        keychain=company.MacKeychainSecretStore(backend=ExplodingKeychain()),
        settings=ExplodingSettings(tmp_path / "settings.json"),
    )
    assert credentials.public_status()["environment"] == "fixture"
    assert credentials.get_provider_credentials() == company.ProviderCredentials(None, None)
    with pytest.raises(company.CompanyCredentialError):
        credentials.save_dart_key(TEST_KEY)


def test_one_optional_provider_storage_failure_does_not_hide_the_other(tmp_path):
    class BrokenKeychain(Keychain):
        def get_password(self, *_args):
            raise RuntimeError("unavailable")

    class BrokenSettings(company.SecUserAgentSettings):
        def read(self):
            raise company.CompanyCredentialStoreUnavailable("unavailable")

    sec_only = company.CompanyCredentialManager(
        enabled=True,
        keychain=company.MacKeychainSecretStore(backend=BrokenKeychain()),
        settings=company.SecUserAgentSettings(tmp_path / "sec-only.json"),
    )
    sec_only.save_sec_user_agent(TEST_AGENT)
    assert sec_only.get_provider_credentials().sec_user_agent == TEST_AGENT
    assert sec_only.get_provider_credentials().dart_api_key is None

    keychain = Keychain()
    keychain.set_password("com.kiwoom.mac-readonly.company-data", "dart-api-key-v1", TEST_KEY)
    dart_only = company.CompanyCredentialManager(
        enabled=True,
        keychain=company.MacKeychainSecretStore(backend=keychain),
        settings=BrokenSettings(tmp_path / "broken.json"),
    )
    assert dart_only.get_provider_credentials().sec_user_agent is None
    assert dart_only.get_provider_credentials().dart_api_key == TEST_KEY


def test_native_keychain_replace_uses_installed_api_shape_without_keychain_access():
    class Call:
        def __init__(self, result):
            self.result, self.calls, self.restype, self.argtypes = result, [], None, None

        def __call__(self, *args):
            self.calls.append(args)
            return self.result

    class Error:
        item_not_found = -25300

        @staticmethod
        def raise_for_status(status):
            assert status == 0

    error = Error()

    class FakeApi:
        OS_status = int
        def __init__(self):
            self.error = error
            self.Error = Error
            self._sec = type("Sec", (), {"SecItemUpdate": Call(Error.item_not_found)})()
            self._found = type("Found", (), {"CFDataCreate": Call(99), "CFRelease": Call(None)})()
            self.add = Call(0)
            self.SecItemAdd = self.add
            self.queries = []

        @staticmethod
        def k_(value):
            return value

        def create_query(self, **kwargs):
            self.queries.append(kwargs)
            return len(self.queries)

    api = FakeApi()
    company.MacKeychainSecretStore._native_replace(api, TEST_KEY)
    assert len(api._sec.SecItemUpdate.calls) == 1 and len(api.add.calls) == 1
    assert any(query.get("kSecAttrAccount") == "dart-api-key-v1" for query in api.queries)


def test_validation_rejects_invalid_values_before_any_storage_write(tmp_path):
    keychain = Keychain()
    credentials = manager(tmp_path, keychain=keychain)
    with pytest.raises(ValueError):
        credentials.save_sec_user_agent("contact@example.invalid")
    with pytest.raises(ValueError):
        credentials.save_dart_key("not-a-key")
    assert keychain.writes == 0
    assert not (tmp_path / "settings").exists()


def test_sec_user_agent_requires_ascii_header_safe_english_application_name_before_save(tmp_path):
    credentials = manager(tmp_path)
    assert company.validate_sec_user_agent("Kiwoom Tool support@example.invalid") == "Kiwoom Tool support@example.invalid"
    for invalid in (
        "키움 도구 support@example.invalid",
        "Kiwoom Tool\r\nsupport@example.invalid",
        f"{'K' * 170} support@example.invalid",
    ):
        with pytest.raises(ValueError, match=r"English \(ASCII\) application name"):
            company.validate_sec_user_agent(invalid)
    with pytest.raises(ValueError, match=r"English \(ASCII\) application name"):
        credentials.save_sec_user_agent("키움 도구 support@example.invalid")
    assert not (tmp_path / "settings").exists()


def test_router_requires_root_auth_guard_and_never_echoes_dart_key(monkeypatch, tmp_path):
    keychain = Keychain()
    credentials = manager(tmp_path, keychain=keychain)
    monkeypatch.setattr(company, "credential_manager", credentials)
    app = FastAPI()
    app.include_router(company.router)
    threaded: list[str] = []

    async def on_worker(function, *args):
        threaded.append(function.__name__)
        return function(*args)

    monkeypatch.setattr(company.asyncio, "to_thread", on_worker)
    company._auth_guard = None
    with TestClient(app) as client:
        assert client.get("/api/company-credentials/status").status_code == 503

    calls: list[bool] = []
    company.configure_auth_guard(lambda _request, *, mutation: calls.append(mutation))
    with TestClient(app) as client:
        read = client.get("/api/company-credentials/status")
        assert read.status_code == 200 and read.headers["cache-control"] == "no-store"
        malformed = client.post("/api/company-credentials/dart-key", json={"dartApiKey": TEST_KEY, "extra": "no"})
        assert malformed.status_code == 400 and TEST_KEY not in malformed.text
        saved = client.post("/api/company-credentials/dart-key", json={"dartApiKey": TEST_KEY})
        assert saved.status_code == 200 and TEST_KEY not in saved.text and saved.json()["dartKeyConfigured"] is True
        removed = client.post("/api/company-credentials/dart-key/delete", json={})
        assert removed.status_code == 200 and removed.json()["dartKeyConfigured"] is False
    assert calls == [False, True, True, True]
    assert threaded == ["public_status", "save_dart_key", "delete_dart_key"]
