from app import kiwoom_gateway as gateway


def test_unsupported_row_does_not_break_supported_kr_search(monkeypatch):
    monkeypatch.setattr(gateway, "_fetch_rows", lambda *_args, **_kwargs: ([
        {"code": "005930", "name": "삼성전자", "marketCode": "0"},
        {"code": "00680K", "name": "alphabetic preferred-share code"},
        {"name": "missing code"},
    ], True, ""))
    rows, complete, note = gateway._build_kr_index()
    assert {row["stkCd"] for row in rows} == {"005930", "00680K"}
    assert not complete
    assert "omitted 1 unsupported KR symbols" in note


def test_failed_index_retries_after_negative_cache_ttl(monkeypatch):
    key = (gateway.ENVIRONMENT, "KR")
    monkeypatch.setattr(gateway, "_index_cache", {key: (100.0, [], False, "symbol index unavailable")})
    monkeypatch.setattr(gateway, "_index_loading", set())
    monkeypatch.setattr(gateway.time, "monotonic", lambda: 121.0)
    calls = []
    def build():
        calls.append(True)
        return [{"stkCd": "005930"}], True, ""
    class ImmediateThread:
        def __init__(self, *, target, **_kwargs): self.target = target
        def start(self): self.target()
    monkeypatch.setattr(gateway, "Thread", ImmediateThread)
    monkeypatch.setattr(gateway, "_build_kr_index", build)
    gateway._start_index_load("KR")
    assert calls == [True]
    assert gateway._indexed("KR") == ([{"stkCd": "005930"}], True, "")
    gateway._start_index_load("KR")
    assert len(calls) == 1


def test_partial_supported_index_is_not_mistaken_for_a_failed_load(monkeypatch):
    key = (gateway.ENVIRONMENT, "KR")
    rows = [{"stkCd": "005930"}]
    monkeypatch.setattr(gateway, "_index_cache", {key: (100.0, rows, False, "omitted unsupported symbols")})
    monkeypatch.setattr(gateway.time, "monotonic", lambda: 200.0)
    monkeypatch.setattr(gateway, "Thread", lambda **_kwargs: (_ for _ in ()).throw(AssertionError("must reuse available index")))
    assert gateway._indexed("KR") == (rows, False, "omitted unsupported symbols")
    gateway._start_index_load("KR")
