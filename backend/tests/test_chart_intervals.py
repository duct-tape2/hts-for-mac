import pytest
from app import kiwoom_gateway as gateway


@pytest.mark.parametrize('market,interval,api_id,list_key', [
    ('KR','1','ka10080','stk_min_pole_chart_qry'),
    ('KR','15','ka10080','stk_min_pole_chart_qry'),
    ('KR','D','ka10081','stk_dt_pole_chart_qry'),
    ('KR','W','ka10082','stk_stk_pole_chart_qry'),
    ('KR','M','ka10083','stk_mth_pole_chart_qry'),
    ('KR','Y','ka10094','stk_yr_pole_chart_qry'),
    ('KR','10','ka10080','stk_min_pole_chart_qry'),
    ('KR','45','ka10080','stk_min_pole_chart_qry'),
    ('US','60','usa06011','result_list'),
    ('US','D','usa06012','result_list'),
    ('US','W','usa06013','result_list'),
    ('US','M','usa06014','result_list'),
    ('US','Y','usa06015','result_list'),
])
def test_chart_requests_use_official_read_contract(monkeypatch, market, interval, api_id, list_key):
    monkeypatch.setattr(gateway, 'KIWOOM_ENABLED', True)
    monkeypatch.setattr(gateway, '_chart_cache', {})
    calls = []
    daily = interval in {'D','W','M','Y'}
    def rows(api, path, body, key, **kwargs):
        calls.append((api, path, body, key))
        return [{'dt':'20261023','cntr_tm':'20261023153000','cur_prc':'-100','open_pric':'99','high_pric':'101','low_pric':'98','trde_qty':'0','acc_trde_qty':'17'}], True, ''
    monkeypatch.setattr(gateway, '_fetch_rows', rows)
    chart = gateway.get_chart(market=market, stk_cd='005930' if market=='KR' else 'AAPL', interval=interval)
    assert calls[0][0] == api_id and calls[0][3] == list_key
    assert (api_id, calls[0][1]) in gateway.ALLOWED_CALLS
    assert ('tic_scope' not in calls[0][2]) if daily else calls[0][2]['tic_scope'] == interval
    assert chart['interval'] == interval
    assert chart['bars'][0]['c'] == 100
    assert chart['bars'][0]['v'] == (17 if market=='US' and daily else 0)
    assert len(chart['bars'][0]['t']) == (8 if daily else 14)


@pytest.mark.parametrize('interval', sorted(gateway.CHART_INTERVALS))
def test_fixture_intervals_are_ordered_valid_and_explicit(interval):
    chart = gateway.get_chart(market='KR', stk_cd='005930', interval=interval)
    assert chart['source'] == 'fixture'
    stamps = [bar['t'] for bar in chart['bars']]
    assert len(stamps) == 180 and stamps == sorted(set(stamps))
    assert all(bar['l'] <= min(bar['o'],bar['c']) <= max(bar['o'],bar['c']) <= bar['h'] for bar in chart['bars'])


def test_chart_refresh_keeps_history_but_preserves_fresh_partial_coverage(monkeypatch):
    monkeypatch.setattr(gateway, 'KIWOOM_ENABLED', True)
    monkeypatch.setattr(gateway, '_chart_cache', {})
    identity = gateway._identity(market='KR', stk_cd='005930', stex_tp=None, listing_venue=None)
    key = gateway._cache_key(identity, 'chart', 'D')
    gateway._chart_cache[key] = (0.0, {**identity, 'bars': [{'t': '20261020', 'o': 90.0, 'h': 101.0, 'l': 89.0, 'c': 100.0, 'v': 10.0}], 'complete': True})
    monkeypatch.setattr(
        gateway,
        '_fetch_rows',
        lambda *_args, **_kwargs: ([{'dt': '20261020', 'open_pric': '90', 'high_pric': '101', 'low_pric': '89', 'cur_prc': '100', 'trde_qty': '10'}, {'dt': '20261025', 'open_pric': '10000', 'high_pric': '10200', 'low_pric': '9900', 'cur_prc': '10100', 'trde_qty': '3'}], False, 'pagination capped at 2 pages'),
    )

    chart = gateway.get_chart(market='KR', stk_cd='005930', interval='D')

    assert [bar['t'] for bar in chart['bars']] == ['20261020', '20261025']
    assert chart['complete'] is False
    assert 'Latest pages refreshed' in chart['note']
    assert 'pagination capped at 2 pages' in chart['note']


def test_same_feed_concurrent_quotes_make_one_upstream_snapshot(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import time
    monkeypatch.setattr(gateway, 'KIWOOM_ENABLED', True)
    monkeypatch.setattr(gateway, '_quote_cache', {})
    calls = []
    def quote(identity, **kwargs):
        calls.append(1)
        time.sleep(0.03)
        return {**identity,'last':100}
    monkeypatch.setattr(gateway, '_kr_quote', quote)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(gateway.get_quote, market='KR', stk_cd='005930') for _ in range(4)]
        assert [future.result()['last'] for future in futures] == [100]*4
    assert len(calls) == 1
