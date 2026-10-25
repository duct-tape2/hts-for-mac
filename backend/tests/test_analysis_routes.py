from types import SimpleNamespace
from fastapi.testclient import TestClient
import pytest
from app.main import app
from app import analysis_routes


@pytest.fixture
def analysis(monkeypatch):
    calls = []
    def get_feature(feature_id, params, *, instrument):
        calls.append((feature_id,params,instrument))
        return {'featureId':feature_id,'status':'snapshot','rows':[],'complete':True}
    module = SimpleNamespace(get_feature=get_feature)
    monkeypatch.setattr(analysis_routes,'_registry',lambda: {'kr-test':(module,{
        'title':'검증','market':'KR','description':'테스트',
        'apiId':'not exposed','path':'not exposed',
        'parameters':[{'key':'period','label':'기간','type':'select','default':'1','options':[{'value':'1','label':'하루'}]}],
    })})
    monkeypatch.setattr(analysis_routes,'_cache',{})
    return TestClient(app),calls


def test_catalogue_exposes_controls_not_transport(analysis):
    client,_=analysis
    row=client.get('/api/analysis/features').json()['features'][0]
    assert row['id']=='kr-test'
    assert 'apiId' not in row and 'path' not in row


@pytest.mark.parametrize('url',[
    '/api/analysis/orders',
    '/api/analysis/kr-test?apiId=kt10000',
    '/api/analysis/kr-test?period=1&period=2',
    '/api/analysis/kr-test?url=https://example.com',
])
def test_unknown_or_duplicate_input_never_reaches_adapter(analysis,url):
    client,calls=analysis
    assert client.get(url).status_code in (404,422)
    assert calls==[]


def test_identical_reads_share_snapshot_and_identity_is_backend_owned(analysis):
    client,calls=analysis
    url='/api/analysis/kr-test?stkCd=005930&listingVenue=KOSPI&stexTp=KRX&period=1'
    assert client.get(url).status_code==200
    assert client.get(url).status_code==200
    assert len(calls)==1
    assert calls[0][2]['environment']=='fixture'
    assert calls[0][1]=={'period':'1'}


def test_text_limits_only_expand_for_declared_metadata(analysis, monkeypatch):
    client, calls = analysis
    registry = analysis_routes._registry()
    registry['kr-test'][1]['parameters'].append({'key':'symbols','maxLength':2048})
    monkeypatch.setattr(analysis_routes, '_registry', lambda: registry)
    assert client.get('/api/analysis/kr-test', params={'symbols':'A'*500}).status_code == 200
    assert client.get('/api/analysis/kr-test', params={'symbols':'A'*2049}).status_code == 422
    assert client.get('/api/analysis/kr-test', params={'period':'A'*161}).status_code == 422
    assert len(calls) == 1
