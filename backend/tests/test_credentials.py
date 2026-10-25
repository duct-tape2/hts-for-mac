from __future__ import annotations

import threading
import time
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from kiwoom.core.errors import InvalidCredentialsError
from kiwoom.core.token_store import TokenRecord

from app import main
from app.credentials import RETRY_INITIAL_SECONDS, CredentialManager, CredentialStoreUnavailable, CredentialValidationFailed, StoredCredential


class Store:
    def __init__(self, record=None, fail=False):
        self.record, self.fail, self.writes = record, fail, 0

    def read(self):
        return self.record

    def create(self, record):
        if self.record is not None:
            raise CredentialStoreUnavailable("already exists")
        self.write(record)

    def write(self, record):
        self.writes += 1
        if self.fail:
            raise RuntimeError("synthetic store failure")
        self.record = record


def token(value, now, seconds):
    return TokenRecord(value, "bearer", now + timedelta(seconds=seconds), "real", credential_fingerprint="synthetic", saved_at=now)


def record(value, now, seconds=3600):
    return StoredCredential("synthetic-key", "synthetic-secret", date(2028, 1, 2), token(value, now, seconds))


def manager(store, clock, legacy=None):
    result = CredentialManager("real", enabled=True, store=store, now=lambda: clock["now"], legacy_token_loader=legacy or (lambda _mode: None))
    result.set_authorizer(lambda: None)
    return result


def test_startup_legacy_migration_is_memory_only_and_status_never_has_secret():
    now = datetime(2026, 10, 24, tzinfo=UTC)
    store = Store()
    auth = manager(store, {"now": now}, legacy=lambda _mode: token("legacy-token", now, 3600))
    status = auth.public_status()
    assert status["stored"] is False and status["storage"] == "none"
    assert auth.get_access_token() == "legacy-token" and store.writes == 0
    assert "legacy-token" not in str(status) and "synthetic" not in str(status)


def test_locked_keychain_retries_after_unlock_without_restart_or_reentry():
    now = datetime(2027, 1, 1, tzinfo=UTC)

    class LockableStore(Store):
        locked = True

        def read(self):
            if self.locked:
                raise CredentialStoreUnavailable("synthetic locked")
            return self.record

    clock, store = {"now": now}, LockableStore(record("stored-token", now))
    auth = manager(store, clock)
    assert auth.public_status()["storage"] == "unavailable"
    store.locked = False
    clock["now"] = now + timedelta(seconds=2)
    status = auth.public_status()
    assert status["storage"] == "keychain" and status["stored"] is True
    assert auth.get_access_token() == "stored-token"


def test_concurrent_near_expiry_refresh_attempts_once_and_keeps_valid_old_token():
    now = datetime(2027, 1, 1, tzinfo=UTC)
    clock, calls = {"now": now}, []
    auth = manager(Store(record("old-token", now, 300)), clock)

    def failing_issue(*_args):
        calls.append(1)
        time.sleep(0.03)
        raise RuntimeError("synthetic transient")

    auth._issue_with_credentials = failing_issue  # type: ignore[method-assign]
    results = []
    threads = [threading.Thread(target=lambda: results.append(auth.get_access_token())) for _ in range(20)]
    [thread.start() for thread in threads]
    [thread.join() for thread in threads]
    assert results == ["old-token"] * 20 and len(calls) == 1
    assert auth.public_status()["status"] == "retrying"
    clock["now"] = now + timedelta(seconds=301)
    with pytest.raises(CredentialValidationFailed):
        auth.get_access_token()


def test_concurrent_401_recovery_is_coalesced_by_generation():
    now, calls = datetime(2027, 1, 1, tzinfo=UTC), []
    auth = manager(Store(record("old-token", now)), {"now": now})

    def issue(*_args):
        calls.append(1)
        time.sleep(0.03)
        return token("new-token", now, 7200)

    auth._issue_with_credentials = issue  # type: ignore[method-assign]
    barrier, results = threading.Barrier(20), []

    def recover():
        auth.get_access_token()
        barrier.wait()
        results.append(auth.recover_from_auth_failure())

    threads = [threading.Thread(target=recover) for _ in range(20)]
    [thread.start() for thread in threads]
    [thread.join() for thread in threads]
    assert len(calls) == 1 and results == ["new-token"] * 20


def test_invalid_or_unpersistable_replacement_keeps_active_local_credentials():
    now = datetime(2027, 1, 1, tzinfo=UTC)
    store, auth = Store(record("old-token", now)), manager(Store(record("old-token", now)), {"now": now})
    # Reload with the actual store after constructing the concise test double.
    auth = manager(store, {"now": now})
    auth.public_status()
    auth._issue_with_credentials = lambda *_args: (_ for _ in ()).throw(InvalidCredentialsError(8001, "synthetic"))  # type: ignore[method-assign]
    with pytest.raises(InvalidCredentialsError):
        auth.register(app_key="new-key-123", app_secret="new-secret-123", registered_expires_on=date(2028, 1, 2))
    assert store.record.app_key == "synthetic-key"
    auth._issue_with_credentials = lambda *_args: token("new-token", now, 7200)  # type: ignore[method-assign]
    store.fail = True
    with pytest.raises(Exception):
        auth.register(app_key="new-key-123", app_secret="new-secret-123", registered_expires_on=date(2028, 1, 2))
    assert store.record.app_key == "synthetic-key" and auth.get_access_token() == "old-token"


def test_registration_and_refresh_share_one_mutation_lane_without_stale_overwrite():
    now = datetime(2027, 1, 1, tzinfo=UTC)
    store, auth = Store(record("old-token", now, 300)), manager(Store(record("old-token", now, 300)), {"now": now})
    auth = manager(store, {"now": now})
    refresh_started, release_refresh = threading.Event(), threading.Event()

    def issue(app_key, _secret):
        if app_key == "synthetic-key":
            refresh_started.set()
            assert release_refresh.wait(1)
            return token("refresh-token", now, 7200)
        return token("registered-token", now, 7200)

    auth._issue_with_credentials = issue  # type: ignore[method-assign]
    refresh = threading.Thread(target=auth.get_access_token)
    refresh.start()
    assert refresh_started.wait(1)
    registration = threading.Thread(
        target=lambda: auth.register(app_key="new-key-123", app_secret="new-secret-123", registered_expires_on=date(2028, 1, 2))
    )
    registration.start()
    release_refresh.set()
    refresh.join(1)
    registration.join(1)
    assert not refresh.is_alive() and not registration.is_alive()
    assert store.record.app_key == "new-key-123" and auth.get_access_token() == "registered-token"


@pytest.mark.parametrize(("days_from_expiry", "due", "expired"), [(-8, False, False), (-7, True, False), (0, True, False), (1, True, True)])
def test_kst_seven_day_registration_boundaries_for_the_user_entered_date(days_from_expiry, due, expired):
    registered_on = date(2031, 5, 19)
    day = registered_on + timedelta(days=days_from_expiry)
    now = datetime(day.year, day.month, day.day, 12, tzinfo=UTC)
    saved = StoredCredential("synthetic-key", "synthetic-secret", registered_on, token("stored-token", now, 3600))
    auth = manager(Store(saved), {"now": now})
    status = auth.public_status()
    assert status["registeredExpiresOn"] == registered_on.isoformat()
    assert status["remindOn"] == (registered_on - timedelta(days=7)).isoformat()
    assert status["renewalDue"] is due and status["registrationExpired"] is expired
    assert status["tokenExpiresAt"] != status["registeredExpiresOn"]


def test_unregistered_and_fixture_statuses_leave_registration_dates_unknown():
    now = datetime(2031, 5, 12, tzinfo=UTC)
    fresh = manager(Store(), {"now": now}).public_status()
    fixture = CredentialManager("real", enabled=False, store=Store(), now=lambda: now).public_status()
    for status in (fresh, fixture):
        assert status["registeredExpiresOn"] is None
        assert status["remindOn"] is None
        assert status["renewalDue"] is False
        assert status["registrationExpired"] is False


def test_saved_key_without_a_token_is_ready_for_on_demand_refresh_not_reregistration():
    now = datetime(2027, 1, 1, tzinfo=UTC)
    saved = StoredCredential("synthetic-key", "synthetic-secret", date(2028, 1, 2), token=None)
    auth = manager(Store(saved), {"now": now})

    status = auth.public_status()

    assert status["stored"] is True and status["tokenExpiresAt"] is None
    assert status["status"] == "ready"
    assert "첫 조회" in status["message"] and "등록" not in status["message"]


def test_expired_idle_saved_token_is_ready_for_automatic_refresh():
    now = datetime(2027, 1, 1, tzinfo=UTC)
    auth = manager(Store(record("expired-token", now, -1)), {"now": now})

    status = auth.public_status()

    assert status["stored"] is True and status["tokenExpiresAt"] is not None
    assert status["status"] == "ready"
    assert "첫 조회" in status["message"]


def test_transient_refresh_failure_does_not_tell_user_to_replace_keys_but_invalid_does():
    now = datetime(2027, 1, 1, tzinfo=UTC)
    clock = {"now": now}
    transient = manager(Store(record("expired-token", now, -1)), clock)
    transient._issue_with_credentials = lambda *_args: (_ for _ in ()).throw(RuntimeError("synthetic transient"))  # type: ignore[method-assign]
    with pytest.raises(CredentialValidationFailed):
        transient.get_access_token()
    waiting = transient.public_status()
    assert waiting["status"] == "retrying" and "자동" in waiting["message"]
    clock["now"] = now + timedelta(seconds=RETRY_INITIAL_SECONDS + 1)
    after_backoff = transient.public_status()
    assert after_backoff["status"] == "error"
    assert "일시적" in after_backoff["message"] and "다시 확인" not in after_backoff["message"]

    invalid = manager(Store(record("expired-token", now, -1)), {"now": now})
    invalid._issue_with_credentials = lambda *_args: (_ for _ in ()).throw(InvalidCredentialsError(8001, "synthetic"))  # type: ignore[method-assign]
    with pytest.raises(CredentialValidationFailed):
        invalid.get_access_token()
    status = invalid.public_status()
    assert status["status"] == "needs_credentials" and "다시 확인" in status["message"]


def test_auth_routes_gate_before_auth_and_do_not_echo_secret(monkeypatch):
    called = False

    def no_register(**_kwargs):
        nonlocal called
        called = True
        raise AssertionError("credential auth should not run")

    monkeypatch.setattr(main.credential_manager, "register", no_register)
    with TestClient(main.app) as client:
        assert client.get("/api/auth/status").status_code == 403
        read = client.get("/api/auth/status", headers={"Sec-Fetch-Site": "same-origin"})
        assert read.status_code == 200 and read.headers["cache-control"] == "no-store"
        assert client.post("/api/auth/credentials", content=b"{}", headers={"Sec-Fetch-Site": "same-site"}).status_code == 403
        setup = read.json()["setupToken"]
        headers = {"Sec-Fetch-Site": "same-site", "Origin": "http://127.0.0.1:3010", "X-HTS-Setup": setup}
        secret = "synthetic-secret-never-echo"
        response = client.post("/api/auth/credentials", json={"appKey": "short", "appSecret": secret, "registeredExpiresOn": "2028-01-02"}, headers=headers)
    assert called is False and response.status_code == 400 and secret not in response.text


def test_fixture_auth_status_does_not_touch_keychain_or_broker(monkeypatch):
    class ExplodingStore:
        def read(self):
            raise AssertionError("fixture must not read Keychain")

    monkeypatch.setattr(main.credential_manager, "_store", ExplodingStore())
    monkeypatch.setattr(main.credential_manager, "_loaded", False)
    with TestClient(main.app) as client:
        response = client.get("/api/auth/status", headers={"Sec-Fetch-Site": "same-origin"})
    assert response.status_code == 200 and response.json()["environment"] == "fixture"


def test_explicit_launcher_save_keeps_secrets_backend_only_and_cannot_replace(monkeypatch):
    from kiwoom.core.secrets import CredentialSet, EnvSecretProvider
    now = datetime(2026, 10, 24, tzinfo=UTC)
    monkeypatch.setattr(EnvSecretProvider, "get_credentials", lambda *_: CredentialSet(appkey="launcher-key", secretkey="launcher-secret", source="env"))
    store = Store()
    auth = manager(store, {"now": now})
    calls = []
    def issue(key, secret):
        calls.append((key, secret))
        return token("private-launcher-token", now, 7200)
    auth._issue_with_credentials = issue
    assert auth.public_status()["canSaveLauncher"] is True
    status = auth.register_from_launcher(registered_expires_on=date(2028, 1, 2))
    assert status["stored"] is True and status["canSaveLauncher"] is False
    assert store.record.app_key == "launcher-key" and len(calls) == 1
    assert not any(value in str(status) for value in ("launcher-key", "launcher-secret", "private-launcher-token"))
    with pytest.raises(CredentialValidationFailed):
        auth.register_from_launcher(registered_expires_on=date(2028, 1, 2))
    assert len(calls) == 1 and store.writes == 1


def test_launcher_save_failure_preserves_volatile_token_and_does_not_claim_saved(monkeypatch):
    from kiwoom.core.secrets import CredentialSet, EnvSecretProvider
    now = datetime(2026, 10, 24, tzinfo=UTC)
    monkeypatch.setattr(EnvSecretProvider, "get_credentials", lambda *_: CredentialSet(appkey="launcher-key", secretkey="launcher-secret", source="env"))
    store = Store(fail=True)
    auth = manager(store, {"now": now}, legacy=lambda _: token("old-token", now, 7200))
    auth.public_status()
    auth._issue_with_credentials = lambda *_: token("new-token", now, 7200)
    with pytest.raises(RuntimeError):
        auth.register_from_launcher(registered_expires_on=date(2028, 1, 2))
    assert auth.public_status()["stored"] is False and auth.get_access_token() == "old-token"


def test_launcher_save_route_is_gated_strict_and_secret_free(monkeypatch):
    calls = []
    def adopt(**kwargs):
        calls.append(kwargs)
        return {"stored": True}
    monkeypatch.setattr(main.credential_manager, "register_from_launcher", adopt)
    with TestClient(main.app) as client:
        path = "/api/auth/credentials/from-launcher"
        body = {"registeredExpiresOn": "2028-01-02"}
        assert client.post(path, json=body).status_code == 403
        read = client.get("/api/auth/status", headers={"Sec-Fetch-Site": "same-origin"})
        headers = {"Sec-Fetch-Site": "same-site", "Origin": "http://127.0.0.1:3010", "X-HTS-Setup": read.json()["setupToken"]}
        for invalid in ({**body, "appKey": "never-echo"}, {"registeredExpiresOn": "invalid"}):
            response = client.post(path, json=invalid, headers=headers)
            assert response.status_code == 400 and "never-echo" not in response.text
        assert calls == []
        response = client.post(path, json=body, headers=headers)
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert calls == [{"registered_expires_on": date(2028, 1, 2)}]


def test_launcher_adoption_cannot_overwrite_record_added_by_other_process(monkeypatch):
    from kiwoom.core.secrets import CredentialSet, EnvSecretProvider
    now = datetime(2026, 10, 24, tzinfo=UTC)
    monkeypatch.setattr(EnvSecretProvider, "get_credentials", lambda *_: CredentialSet(appkey="launcher-key", secretkey="launcher-secret", source="env"))
    store = Store()
    auth = manager(store, {"now": now})
    auth.public_status()  # Cache the initial empty result.
    other = record("other-token", now)
    def issue(*_):
        store.record = other  # Another process saves after the local check.
        return token("candidate-token", now, 7200)
    auth._issue_with_credentials = issue
    with pytest.raises(CredentialStoreUnavailable):
        auth.register_from_launcher(registered_expires_on=date(2028, 1, 2))
    assert store.record is other and store.writes == 0
