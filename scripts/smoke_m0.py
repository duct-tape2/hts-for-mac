#!/usr/bin/env python3
"""Exercise the running local fixture API. Never calls a broker or reads credentials."""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = 'http://127.0.0.1:8010'


def request(path, method='GET', data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(BASE + path, data=body, method=method,
                                 headers={'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:3010'})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None


def ok(path, method='GET', data=None):
    status, body = request(path, method, data)
    assert 200 <= status < 300, '%s %s -> %s' % (method, path, status)
    return body


def main():
    health = ok('/api/health')
    assert health['mode'] == 'fixture', 'Smoke requires fixture; refusing any live environment'
    schema = ok('/openapi.json')['paths']
    assert not any(p.startswith(('/api/orders', '/api/account', '/api/trades')) for p in schema)
    for path in ['/api/orders', '/api/orders/able', '/api/orders/test/modify', '/api/orders/test/cancel']:
        status, _ = request(path, 'POST', {'api_id': 'ust20000'})
        assert status in (404, 405), 'Order route remains: ' + path
    print('PASS: removed order routes and OpenAPI')
    instruments = []
    for market, query, currency in [('KR', '005930', 'KRW'), ('US', 'BRK.B', 'USD')]:
        search = ok('/api/symbols/search?' + urllib.parse.urlencode({'q': query, 'market': market}))
        hit = next(row for row in search['results'] if row['stkCd'] == query)
        instruments.append(hit)
        params = urllib.parse.urlencode({'stk_cd': hit['stkCd'], 'stex_tp': hit['stexTp'],
                                         'market': market, 'listing_venue': hit['listingVenue']})
        quote = ok('/api/quotes?' + params)
        chart = ok('/api/charts?' + params + '&interval=D')
        for payload in [quote, chart]:
            assert payload['stkCd'] == query and payload['market'] == market
            assert payload['currency'] == currency and payload['environment'] == 'fixture'
            assert payload['source'] == 'fixture'
        assert quote['last'] is not None
        assert chart['bars'], 'No daily fixture bars'
        assert len(quote['asks']) == 10 and len(quote['bids']) == 10
    print('PASS: KR 005930 / US BRK.B, currency, fixture labels, 10 levels, daily charts')
    name = 'smoke-' + uuid.uuid4().hex[:12]
    state = ok('/api/watchlists', 'POST', {'name': name})
    group = next(g for g in state['watchlists'] if g['name'] == name)
    try:
        for hit in instruments:
            ok('/api/watchlists/' + group['id'] + '/items', 'POST', hit)
        ok('/api/watchlists/' + group['id'] + '/save', 'POST', {})
        state = ok('/api/state')
        items = [x for x in state['items'] if x['watchlistId'] == group['id']]
        assert {x['stkCd'] for x in items} == {'005930', 'BRK.B'}
        assert not any(x in state for x in ['orders', 'fills', 'positions', 'cashUsd'])
        print('PASS: local mixed-market group add/save/read without account state')
    finally:
        ok('/api/watchlists/' + group['id'], 'DELETE')
    print('PASS: local API smoke; real market data NOT RUN')


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, KeyError, StopIteration, urllib.error.URLError) as error:
        print('FAIL:', str(error) or type(error).__name__, file=sys.stderr)
        sys.exit(1)
