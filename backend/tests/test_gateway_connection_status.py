from __future__ import annotations

from types import SimpleNamespace

import pytest
import requests

from app import kiwoom_gateway as gateway
from kiwoom.core.errors import APIError, AuthenticationError, HTTPRequestError


API_ID = "ka10001"
PATH = "/api/dostk/stkinfo"
SECRET = "app-secret=must-not-appear"


class Client:
    def __init__(self, outcome):
        self.outcome = outcome

    def fetch_page(self, **_kwargs):
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


@pytest.fixture(autouse=True)
def isolated_fetch(monkeypatch):
    monkeypatch.setattr(gateway, "_policy", lambda *_args: None)
    monkeypatch.setattr(gateway, "_pace", lambda *_args: None)
    gateway._set_status(connected=False)


def _fetch(monkeypatch, outcome):
    monkeypatch.setattr(gateway, "_client", lambda: Client(outcome))
    return gateway._fetch_page(API_ID, PATH, {"stk_cd": "005930"})


def test_business_api_and_http_errors_keep_reachable_status_and_safe_numeric_code(monkeypatch):
    gateway._set_status(connected=True)
    with pytest.raises(gateway.BrokerError) as business_error:
        _fetch(monkeypatch, APIError(1700, SECRET))
    business = gateway.status()
    assert business == {"connected": True, "mode": gateway.ENVIRONMENT, "error": "Kiwoom ka10001 rejected request (code 1700)"}
    assert SECRET not in str(business) + str(business_error.value)

    with pytest.raises(gateway.BrokerError):
        _fetch(monkeypatch, HTTPRequestError(429, SECRET))
    http = gateway.status()
    assert http["connected"] is True and http["error"] == "Kiwoom ka10001 rejected request"
    assert SECRET not in str(http)


def test_authentication_and_network_errors_mark_disconnected_without_provider_text(monkeypatch):
    gateway._set_status(connected=True)
    with pytest.raises(gateway.BrokerError):
        _fetch(monkeypatch, AuthenticationError(SECRET))
    auth = gateway.status()
    assert auth["connected"] is False and auth["error"] == "Kiwoom authentication failed"

    gateway._set_status(connected=True)
    with pytest.raises(gateway.BrokerError):
        _fetch(monkeypatch, requests.exceptions.ConnectionError(SECRET))
    network = gateway.status()
    assert network["connected"] is False and network["error"] == "Kiwoom transport unavailable"
    assert SECRET not in str(auth) + str(network)


def test_unknown_exception_preserves_previous_false_state_and_never_fabricates_connection(monkeypatch):
    with pytest.raises(gateway.BrokerError):
        _fetch(monkeypatch, RuntimeError(SECRET))
    status = gateway.status()
    assert status["connected"] is False and status["error"] == "Kiwoom request failed"
    assert SECRET not in str(status)


def test_raw_return_code_uses_sdk_typed_auth_classification_without_return_message(monkeypatch):
    gateway._set_status(connected=True)
    with pytest.raises(gateway.BrokerError) as raw_error:
        _fetch(monkeypatch, SimpleNamespace(body={"return_code": "8001", "return_msg": SECRET}))
    auth = gateway.status()
    assert auth["connected"] is False and auth["error"] == "Kiwoom authentication failed"

    with pytest.raises(gateway.BrokerError):
        _fetch(monkeypatch, SimpleNamespace(body={"return_code": "1700", "return_msg": SECRET}))
    business = gateway.status()
    assert business["connected"] is True and business["error"] == "Kiwoom ka10001 rejected request (code 1700)"
    assert SECRET not in str(auth) + str(business) + str(raw_error.value)


def test_failure_notes_never_echo_arbitrary_provider_messages():
    error = gateway.BrokerError("SECRET provider message", provider_code="1504")
    assert "1504" in gateway.read_failure_note(error)
    assert "SECRET" not in gateway.read_failure_note(error)
    unsafe = gateway.BrokerError("SECRET", provider_code="SECRET")
    assert unsafe.provider_code is None
    assert "SECRET" not in gateway.read_failure_note(unsafe)
