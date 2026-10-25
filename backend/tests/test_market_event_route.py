from fastapi.testclient import TestClient
from app.main import app
from app import market_stream


def test_event_route_does_not_create_subscriptions(monkeypatch):
    monkeypatch.setattr(market_stream, 'subscribe', lambda *args: (_ for _ in ()).throw(AssertionError('must not subscribe')))
    monkeypatch.setattr(market_stream, 'event_journal', lambda *args, **kwargs: None)
    response = TestClient(app).get('/api/market/events?market=KR&stk_cd=005930&stex_tp=KRX&listing_venue=KOSPI')
    assert response.status_code == 200
    assert response.json()['events'] == []
    assert response.json()['identity']['environment'] == 'fixture'


def test_event_route_enforces_cursor_and_buffer_limits():
    client = TestClient(app)
    for suffix in ['limit=257', 'after_sequence=-1', 'limit=0']:
        response = client.get('/api/market/events?market=KR&stk_cd=005930&'+suffix)
        assert response.status_code == 422
