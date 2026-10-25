from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import condition_routes as routes
from app import condition_search


REGISTRATION_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90"


def _client(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    monkeypatch.setattr(routes, "_auth_guard", None)
    return TestClient(app)


def test_list_result_and_status_validate_market_and_seq_without_blocking_event_loop(monkeypatch):
    calls: list[tuple[str, tuple[object, ...], dict[str, object]]] = []

    def record(name, payload):
        def callback(*args, **kwargs):
            calls.append((name, args, kwargs))
            return payload
        return callback

    monkeypatch.setattr(routes.market_stream, "condition_list", record("list", {"market": "KR", "conditions": []}))
    monkeypatch.setattr(routes.market_stream, "condition_result", record("result", {"market": "KR", "seq": "4", "rows": []}))
    monkeypatch.setattr(routes.market_stream, "condition_status", record("status", {"market": "KR", "seq": "4", "active": False}))
    with _client(monkeypatch) as client:
        listed = client.get("/api/conditions/kr/list")
        result = client.get("/api/conditions/KR/result?seq=4")
        status = client.get("/api/conditions/KR/status?seq=4")
        bad_market = client.get("/api/conditions/JP/list")
        bad_seq = client.get("/api/conditions/KR/result?seq=not-a-seq")
        duplicate_seq = client.get("/api/conditions/KR/status?seq=4&seq=5")

    assert [response.status_code for response in (listed, result, status)] == [200, 200, 200]
    assert listed.headers["cache-control"] == "no-store"
    assert [response.status_code for response in (bad_market, bad_seq, duplicate_seq)] == [400, 400, 400]
    assert calls == [
        ("list", ("KR",), {}),
        ("result", ("KR", "4"), {}),
        ("status", ("KR", "4"), {}),
    ]


def test_subscription_and_unsubscription_require_configured_mutation_guard_and_exact_body(monkeypatch):
    calls: list[tuple[str, tuple[object, ...], dict[str, object]]] = []

    def subscribe(*args, **kwargs):
        calls.append(("subscribe", args, kwargs))
        return {"market": "KR", "seq": "7", "live": {"state": "active", "registrationId": REGISTRATION_ID}}

    def unsubscribe(*args, **kwargs):
        calls.append(("unsubscribe", args, kwargs))
        return {"market": "KR", "seq": "7", "unsubscribed": True}

    monkeypatch.setattr(routes.market_stream, "condition_result", subscribe)
    monkeypatch.setattr(routes.market_stream, "condition_unsubscribe", unsubscribe)
    with _client(monkeypatch) as client:
        unavailable = client.post("/api/conditions/KR/subscribe", json={"seq": "7"})
        assert unavailable.status_code == 503

        guarded: list[bool] = []
        routes.configure_auth_guard(lambda _request, *, mutation: guarded.append(mutation))
        malformed = client.post("/api/conditions/KR/subscribe", json={"seq": "7", "extra": True})
        started = client.post("/api/conditions/KR/subscribe", json={"seq": "7"})
        stopped = client.post("/api/conditions/KR/unsubscribe", json={"seq": "7", "registrationId": REGISTRATION_ID})

    assert malformed.status_code == 400
    assert started.status_code == stopped.status_code == 200
    assert guarded == [True, True, True]
    assert calls == [
        ("subscribe", ("KR", "7"), {"realtime": True}),
        ("unsubscribe", ("KR", "7"), {"registration_id": REGISTRATION_ID}),
    ]


def test_unsubscribe_rejects_missing_or_invalid_registration_id_before_market_stream(monkeypatch):
    calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def unsubscribe(*args, **kwargs):
        calls.append((args, kwargs))
        return {"market": "KR", "seq": "7", "unsubscribed": True}

    monkeypatch.setattr(routes.market_stream, "condition_unsubscribe", unsubscribe)
    with _client(monkeypatch) as client:
        routes.configure_auth_guard(lambda _request, *, mutation: None)
        missing = client.post("/api/conditions/KR/unsubscribe", json={"seq": "7"})
        short = client.post("/api/conditions/KR/unsubscribe", json={"seq": "7", "registrationId": "a" * 31})
        uppercase = client.post("/api/conditions/KR/unsubscribe", json={"seq": "7", "registrationId": "A" * 32})
        extra = client.post("/api/conditions/KR/unsubscribe", json={"seq": "7", "registrationId": REGISTRATION_ID, "extra": True})
        bad_seq = client.post("/api/conditions/KR/unsubscribe", json={"seq": "not-a-seq", "registrationId": REGISTRATION_ID})
        accepted = client.post("/api/conditions/KR/unsubscribe", json={"seq": "7", "registrationId": REGISTRATION_ID})

    assert [response.status_code for response in (missing, short, uppercase, extra, bad_seq)] == [400, 400, 400, 400, 400]
    assert accepted.status_code == 200
    assert calls == [(('KR', '7'), {"registration_id": REGISTRATION_ID})]


def test_transport_errors_are_safe_and_do_not_fake_fixture_results(monkeypatch):
    def unavailable(*_args, **_kwargs):
        raise condition_search.ConditionSearchError("broker timeout: raw request payload")

    monkeypatch.setattr(routes.market_stream, "condition_list", unavailable)
    with _client(monkeypatch) as client:
        response = client.get("/api/conditions/KR/list")

    assert response.status_code == 503
    assert response.json() == {"detail": "saved-condition request is unavailable"}
    assert "payload" not in response.text
