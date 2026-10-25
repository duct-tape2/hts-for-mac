from types import SimpleNamespace
import pytest
from app import kiwoom_gateway as gateway


def bar(t, price):
    return {'t': t, 'o': price, 'h': price+1, 'l': price-1, 'c': price, 'v': 1}


@pytest.mark.parametrize('overlap', [False, True])
def test_unverified_or_revised_history_is_replaced(monkeypatch, overlap):
    monkeypatch.setattr(gateway, 'KIWOOM_ENABLED', True)
    identity = gateway._identity(market='KR', stk_cd='005930', stex_tp=None, listing_venue=None)
    key = gateway._cache_key(identity, 'chart', 'D')
    monkeypatch.setattr(gateway, '_chart_cache', {key: (0, {'bars': [bar('20261001',100),bar('20261002',100)], 'complete': True})})
    rows = [{'dt': '20261003', 'open_pric':'50','high_pric':'51','low_pric':'49','cur_prc':'50','trde_qty':'1'}]
    if overlap:
        rows.insert(0, {**rows[0], 'dt':'20261002'})
    monkeypatch.setattr(gateway, '_fetch_rows', lambda *a, **kw: (rows, False, 'continuation key missing'))
    result = gateway.get_chart(market='KR',stk_cd='005930',interval='D')
    assert '20261001' not in [r['t'] for r in result['bars']]
    assert result['complete'] is False
    assert 'replaced' in result['note']
    assert 'continuation key missing' in result['note']


def test_missing_root_is_not_a_successful_empty_result(monkeypatch):
    monkeypatch.setattr(gateway, '_fetch_page', lambda *a, **kw: SimpleNamespace(body={'return_code':0}))
    with pytest.raises(gateway.BrokerError, match='omitted'):
        gateway._fetch_rows('ka10003','/api/dostk/stkinfo',{},'cntr_infr')


def test_explicit_empty_root_is_valid(monkeypatch):
    monkeypatch.setattr(gateway, '_fetch_page', lambda *a, **kw: SimpleNamespace(body={'cntr_infr':[]}))
    assert gateway._fetch_rows('ka10003','/api/dostk/stkinfo',{},'cntr_infr') == ([],True,'')
