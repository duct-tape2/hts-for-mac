"""Independent SDK/adapter integration: requests is intercepted before sockets."""
import json
import os
import socket
import threading
import unittest
from unittest.mock import patch

os.environ['KIWOOM_ENABLED'] = 'false'
os.environ['KIWOOM_MODE'] = 'real'

from app import kiwoom_gateway as gateway
from kiwoom.core.client import KiwoomClient
import requests


class FakeAuth:
    mode = 'real'

    def authorization_header(self):
        return 'Bearer synthetic-test-only'


class SDKBoundary(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.responses = {
            'ka10001': {'stk_cd': '005930', 'stk_nm': '삼성전자', 'cur_prc': '-71500', 'pred_pre': '-500', 'flu_rt': '-0.7'},
            'ka10004': {'sel_fpr_bid': '+71510', 'sel_fpr_req': '0'},
            'ka10099': {'list': [{'code': '005930', 'name': '삼성전자', 'marketCode': '0'}]},
            'ka10081': {'stk_cd': '005930', 'stk_dt_pole_chart_qry': [
                {'dt': '20261023', 'cur_prc': '71500', 'open_pric': '71000', 'high_pric': '72000', 'low_pric': '70000', 'trde_qty': '300'},
                {'dt': '20261022', 'cur_prc': '71000', 'open_pric': '70500', 'high_pric': '71500', 'low_pric': '70000', 'trde_qty': '200'}]},
            'usa20100': {'stk_cd': 'BRK.B', 'stex_tp': 'NY', 'stk_nm': 'Berkshire', 'cur_prc': '498.20', 'pred_pre': '-1.5', 'flu_rt': '-0.3'},
            'usa20101': {'stk_cd': 'BRK.B', 'stex_tp': 'NY', 'sel_1bid': '498.21', 'sel_1bid_req': '4', 'buy_1bid': '498.19', 'buy_1bid_req': '0'},
            'usa06012': {'result_list': [{'dt': '20261023', 'cur_prc': '498.2', 'open_pric': '495', 'high_pric': '499', 'low_pric': '494', 'acc_trde_qty': '900'}]},
            'usa06011': {'result_list': [{'cntr_tm': '20261023103000', 'cur_prc': '498.2', 'open_pric': '498', 'high_pric': '499', 'low_pric': '497', 'trde_qty': '20'}]},
            'usa10098': {'list': [{'stk_cd': 'BRK.B', 'stex_tp': 'NY', 'stk_nm': 'Berkshire'}]},
            'usa10099': {'list': [{'stk_cd': 'BRK.B', 'stex_tp': 'NY', 'stk_nm': 'Berkshire'}]},
            'usa20200': {'rtcd': 'S', 'nofi': [{'gcod': '01', 'name': 'US saved'}]},
            'usa20201': {'rtcd': 'S', 'nofj': [{'cod2': 'BRK.B', 'stex_tp': 'NY'}]},
        }
        client = KiwoomClient(FakeAuth())
        self.stack = []
        for patcher in [patch.object(gateway, 'KIWOOM_ENABLED', True), patch.object(gateway, 'KIWOOM_MODE', 'real'),
                        patch.object(gateway, 'ENVIRONMENT', 'real'), patch.object(gateway, '_client', return_value=client),
                        patch.object(gateway, '_pace'),
                        patch.dict(os.environ, {'PRD': 'https://api.kiwoom.com', 'MOCK': 'https://mockapi.kiwoom.com',
                                                'W_PRD': 'wss://api.kiwoom.com:10000', 'W_MOCK': 'wss://mockapi.kiwoom.com:10000'}),
                        patch.object(socket.socket, 'connect', side_effect=AssertionError('outbound socket forbidden')),
                        patch.object(requests.sessions.Session, 'send', self.send)]:
            patcher.start()
            self.stack.append(patcher)
        gateway._quote_cache.clear()
        gateway._chart_cache.clear()
        gateway._index_cache.clear()
        gateway._exact_cache.clear()

    def tearDown(self):
        for patcher in reversed(self.stack):
            patcher.stop()

    def send(self, request, **kwargs):
        self.assertFalse(kwargs.get('allow_redirects', True), 'redirect following must be disabled')
        api_id = request.headers.get('api-id')
        self.assertIn(api_id, self.responses)
        self.assertEqual(request.method, 'POST')
        self.assertTrue(request.url.startswith('https://api.kiwoom.com/api/'))
        self.calls.append((api_id, request.url, json.loads(request.body)))
        response = requests.Response()
        response.status_code = 200
        response.headers['cont-yn'] = 'N'
        response._content = json.dumps({'return_code': 0, **self.responses[api_id]}).encode()
        response.request = request
        return response

    def test_kr_actual_sdk_mapping_and_daily_order(self):
        quote = gateway.get_quote(market='KR', stk_cd='005930', stex_tp='KRX', listing_venue='KOSPI')
        self.assertEqual(quote['last'], 71500)
        self.assertEqual(quote['change'], -500)
        self.assertEqual(quote['bids'], [])
        self.assertEqual(quote['askQty'], 0)
        self.assertIsNone(quote['midPrice'])
        chart = gateway.get_chart(market='KR', stk_cd='005930', stex_tp='KRX', listing_venue='KOSPI')
        self.assertEqual([b['t'] for b in chart['bars']], ['20261022', '20261023'])
        self.assertEqual([b['v'] for b in chart['bars']], [200, 300])
        self.assertEqual(chart['environment'], 'real')
        self.assertEqual(chart['source'], 'kiwoom')
        self.assertEqual(chart['range'], {'basis': 'provider', 'start': '20261022', 'end': '20261023'})
        rows, complete, _ = gateway._build_kr_index()
        self.assertTrue(complete)
        self.assertEqual(rows[0]['stkCd'], '005930')

    def test_us_existing_read_paths_use_official_requests(self):
        args = dict(market='US', stk_cd='BRK.B', stex_tp='NY', listing_venue='NYSE')
        quote = gateway.get_quote(**args)
        self.assertEqual(quote['last'], 498.2)
        self.assertEqual(quote['bidQty'], 0)
        self.assertEqual(quote['change'], -1.5)
        daily = gateway.get_chart(**args, interval='D')
        self.assertEqual(daily['bars'][0]['v'], 900)
        self.assertEqual(daily['range'], {'basis': 'provider', 'start': '20261023', 'end': '20261023'})
        self.assertEqual(gateway.get_chart(**args, interval='1')['bars'][0]['v'], 20)
        self.assertEqual(gateway._us_exact('BRK.B')[0]['listingVenue'], 'NYSE')
        rows, complete, _ = gateway._build_us_index()
        self.assertTrue(complete)
        self.assertEqual(rows[0]['stkCd'], 'BRK.B')
        groups = gateway.get_hts_watchlists()
        self.assertTrue(groups)
        self.assertTrue(any(call[0] == 'usa20201' for call in self.calls))
        self.assertEqual({c[0] for c in self.calls}, {'usa20100', 'usa20101', 'usa06012', 'usa06011', 'usa10098', 'usa10099', 'usa20200', 'usa20201'})

    def test_final_transport_rejects_id_path_mismatch(self):
        gateway._policy('ka10001', '/api/dostk/stkinfo')
        for api_id, path in [('ust20000', '/api/dostk/stkinfo'), ('ka10001', '/api/us/chart'), ('unknown', '/api/dostk/stkinfo')]:
            with self.subTest(api_id=api_id, path=path):
                with self.assertRaises(gateway.RequestDenied):
                    requests.post('https://api.kiwoom.com' + path, headers={'api-id': api_id}, json={})
        self.assertEqual(self.calls, [])


class PacerConcurrency(unittest.TestCase):
    def test_waiting_universe_does_not_lock_out_current_quote(self):
        sleeping, release, quote_done = threading.Event(), threading.Event(), threading.Event()
        now = [100.0]

        def simulated_sleep(seconds):
            sleeping.set()
            release.wait(2)
            now[0] += seconds

        with patch.object(gateway, '_last_global_call', 0.0), patch.dict(gateway._last_call, {'usa10099': 100.0}, clear=True), patch.object(gateway.time, 'monotonic', lambda: now[0]), patch.object(gateway.time, 'sleep', simulated_sleep):
            slow = threading.Thread(target=gateway._pace, args=('usa10099',), daemon=True)
            fast = threading.Thread(target=lambda: (gateway._pace('ka10001'), quote_done.set()), daemon=True)
            slow.start()
            self.assertTrue(sleeping.wait(1))
            fast.start()
            admitted = quote_done.wait(0.5)
            release.set()
            slow.join(2)
            fast.join(2)
            self.assertTrue(admitted, 'a waiting US universe request blocked the KR quote budget')
            self.assertFalse(slow.is_alive() or fast.is_alive())


if __name__ == '__main__':
    unittest.main()
