from __future__ import annotations

import json

import pytest

from app import company_data as company


SEC_AGENT = "Kiwoom Mac Trading support@example.invalid"


@pytest.fixture(autouse=True)
def clear_company_data_cache(monkeypatch):
    company._clear_caches_for_tests()
    monkeypatch.setattr(company, "_MIN_REQUEST_GAP_SECONDS", 0.0)


def _json(value: dict) -> bytes:
    return json.dumps(value).encode("utf-8")


def test_registry_uses_common_feature_contract_and_fixture_never_calls_transport(monkeypatch):
    monkeypatch.setattr(company, "_transport", lambda *_args, **_kwargs: pytest.fail("fixture must not fetch"))
    assert set(company.FEATURES) == {"sec_filings", "sec_financials", "dart_disclosures", "dart_financials"}
    assert all({"title", "market", "description", "parameters", "source"} <= item.keys() for item in company.FEATURES.values())
    assert all({"key", "label", "type", "default"} <= parameter.keys() for item in company.FEATURES.values() for parameter in item["parameters"])
    assert "dartApiKey" not in {parameter["key"] for parameter in company.FEATURES["dart_disclosures"]["parameters"]}
    assert all("secUserAgent" not in {parameter["key"] for parameter in company.FEATURES[feature_id]["parameters"]} for feature_id in {"sec_filings", "sec_financials"})
    financial_parameters = {parameter["key"]: parameter for parameter in company.FEATURES["dart_financials"]["parameters"]}
    assert financial_parameters["reportCode"]["options"] == [
        {"value": "11013", "label": "1분기보고서"}, {"value": "11012", "label": "반기보고서"},
        {"value": "11014", "label": "3분기보고서"}, {"value": "11011", "label": "사업보고서"},
    ]
    assert financial_parameters["fsDiv"]["options"] == [
        {"value": "CFS", "label": "연결재무제표"}, {"value": "OFS", "label": "개별재무제표"},
    ]

    for feature_id in company.FEATURES:
        result = company.get_feature(feature_id, {}, instrument={"environment": "fixture"})
        assert result["featureId"] == feature_id
        assert result["source"] == result["status"] == "fixture"
        assert result["complete"] is True and result["rows"]
        assert {column["key"] for column in result["columns"]} <= result["rows"][0].keys()


def test_sec_filings_resolve_official_ticker_and_publish_official_archive_link(monkeypatch):
    calls: list[str] = []

    def transport(url, **_kwargs):
        calls.append(url)
        if url.endswith("company_tickers.json"):
            return _json({"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}})
        if "/submissions/CIK0000320193.json" in url:
            return _json({"filings": {"recent": {
                "form": ["10-K", "8-K"],
                "filingDate": ["2026-01-30", "2026-02-01"],
                "reportDate": ["2025-12-31", ""],
                "accessionNumber": ["0000320193-26-000001", "0000320193-26-000002"],
                "primaryDocument": ["annual.htm", "event.htm"],
            }}})
        pytest.fail("unexpected official path")

    monkeypatch.setattr(company, "_transport", transport)
    result = company.get_feature("sec_filings", {"symbol": "aapl", "limit": "1"}, sec_user_agent=SEC_AGENT)

    assert result["source"] == "sec" and result["status"] == "snapshot" and result["complete"] is True
    assert result["scope"]["cik"] == "0000320193"
    assert result["rows"] == [{
        "id": "0000320193-26-000001", "filed": "2026-01-30", "reportDate": "2025-12-31",
        "form": "10-K", "accession": "0000320193-26-000001",
        "officialURL": "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/annual.htm",
    }]
    assert calls == [
        "https://www.sec.gov/files/company_tickers.json",
        "https://data.sec.gov/submissions/CIK0000320193.json",
    ]


def test_sec_setup_and_access_denial_are_explicit_without_fallback_data(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(company, "_transport", lambda url, **_kwargs: calls.append(url) or pytest.fail("setup must not fetch"))
    setup = company.get_feature("sec_filings", {"symbol": "AAPL"})
    assert setup["status"] == "setup-required" and setup["source"] == "sec" and setup["rows"] == []
    assert calls == []

    monkeypatch.setattr(company, "_transport", lambda *_args, **_kwargs: (_ for _ in ()).throw(company.CompanyDataAccessDenied("denied")))
    denied = company.get_feature("sec_financials", {"cik": "320193"}, sec_user_agent=SEC_AGENT)
    assert denied["status"] == "error" and denied["source"] == "sec" and denied["rows"] == []
    assert "Do not bypass" in denied["note"]


def test_sec_companyfacts_selects_actual_reported_periods_and_later_amendments(monkeypatch):
    def transport(url, **_kwargs):
        assert url == "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json"
        return _json({"facts": {"us-gaap": {
            "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
                {"form": "10-K", "fp": "FY", "fy": 2025, "filed": "2026-01-30", "start": "2025-01-01", "end": "2025-12-31", "val": 100},
                {"form": "10-K/A", "fp": "FY", "fy": 2025, "filed": "2026-02-10", "start": "2025-01-01", "end": "2025-12-31", "val": 101},
                {"form": "10-Q", "fp": "Q2", "fy": 2026, "filed": "2026-08-01", "start": "2026-01-01", "end": "2026-06-30", "val": 210},
                {"form": "10-Q", "fp": "Q2", "fy": 2026, "filed": "2026-08-01", "start": "2026-04-01", "end": "2026-06-30", "val": 110},
            ]}},
            "Assets": {"units": {"USD": [
                {"form": "10-Q", "fp": "Q1", "fy": 2026, "filed": "2026-05-01", "start": "2026-01-01", "end": "2026-03-31", "val": 500},
            ]}},
        }}})

    monkeypatch.setattr(company, "_transport", transport)
    result = company.get_feature("sec_financials", {"cik": "320193"}, sec_user_agent=SEC_AGENT)

    revenue = next(row for row in result["rows"] if row["metric"] == "Revenue" and row["fiscalYear"] == 2025)
    q2 = [row for row in result["rows"] if row["metric"] == "Revenue" and row["fiscalYear"] == 2026]
    assert result["source"] == "sec" and result["status"] == "snapshot"
    assert revenue["value"] == 101 and revenue["amendment"] is True and revenue["unit"] == "USD"
    assert {(row["reportStart"], row["periodType"], row["periodKind"], row["value"]) for row in q2} == {
        ("2026-01-01", "yearToDate", "duration", 210),
        ("2026-04-01", "quarterly", "duration", 110),
    }
    assert len({row["id"] for row in q2}) == 2
    assert all(row["periodKind"] in {"duration", "instant"} for row in result["rows"])
    assert "not analyst consensus" in result["note"]


def test_sec_fact_cap_retains_latest_rows_for_every_metric_and_reports_truncation(monkeypatch):
    facts: dict[str, object] = {}
    for metric_index, (_metric_id, _label, tags) in enumerate(company._METRICS):
        entries = []
        for offset in range(40):
            year = 2026 - offset
            entries.append({
                "form": "10-K", "fp": "FY", "fy": year, "filed": f"{year + 1}-02-01",
                "start": f"{year}-01-01", "end": f"{year}-12-31", "val": metric_index * 1_000 + offset,
            })
        facts[tags[0]] = {"units": {"USD": entries}}

    monkeypatch.setattr(company, "_transport", lambda *_args, **_kwargs: _json({"facts": {"us-gaap": facts}}))
    result = company.get_feature("sec_financials", {"cik": "320193"}, sec_user_agent=SEC_AGENT)

    by_metric = {label: [row for row in result["rows"] if row["metric"] == label] for _metric_id, label, _tags in company._METRICS}
    assert result["complete"] is False
    assert len(result["rows"]) == 120
    assert all(len(rows) == 24 and rows[0]["fiscalYear"] == 2026 for rows in by_metric.values())
    assert result["scope"]["returnedRows"] == 120
    assert result["scope"]["availableRows"] == 200
    assert result["scope"]["displayLimit"] == 120
    assert "Displayed 120 of 200 distinct reported facts" in result["note"]


def test_dart_requires_injected_key_then_uses_only_official_list_endpoint(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(company, "_transport", lambda url, **_kwargs: calls.append(url) or pytest.fail("setup must not fetch"))
    setup = company.get_feature("dart_disclosures", {"corpCode": "00126380", "reportPeriod": "2026"})
    assert setup["status"] == "setup-required" and setup["source"] == "dart" and calls == []

    def transport(url, **_kwargs):
        calls.append(url)
        assert url.startswith("https://opendart.fss.or.kr/api/list.json?")
        return _json({"status": "000", "total_page": "1", "list": [{
            "rcept_no": "20260130000001", "rcept_dt": "20260130", "report_nm": "사업보고서",
            "corp_name": "테스트 법인",
        }]})

    monkeypatch.setattr(company, "_transport", transport)
    key = "a" * 40
    result = company.get_feature("dart_disclosures", {"corpCode": "00126380", "reportPeriod": "2026"}, dart_api_key=key)
    repeated = company.get_feature("dart_disclosures", {"corpCode": "00126380", "reportPeriod": "2026"}, dart_api_key=key)
    assert result["source"] == "dart" and result["status"] == "snapshot" and result["complete"] is True
    assert result["rows"][0]["officialURL"] == "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260130000001"
    assert repeated["rows"] == result["rows"] and len(calls) == 2


def test_dart_financials_require_an_injected_key_and_keep_reported_account_context(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(company, "_transport", lambda url, **_kwargs: calls.append(url) or pytest.fail("setup must not fetch"))
    setup = company.get_feature("dart_financials", {"corpCode": "00126380", "reportYear": "2025", "reportCode": "11011", "fsDiv": "CFS"})
    assert setup["status"] == "setup-required" and setup["rows"] == [] and calls == []

    def transport(url, **_kwargs):
        calls.append(url)
        assert url.startswith("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?")
        return _json({"status": "000", "list": [{
            "rcept_no": "20260330000001", "reprt_code": "11011", "bsns_year": "2025", "corp_code": "00126380",
            "fs_div": "CFS", "fs_nm": "연결재무제표", "sj_div": "IS", "sj_nm": "손익계산서",
            "account_id": "ifrs-full_Revenue", "account_nm": "매출액", "account_detail": "",
            "thstrm_nm": "제 57 기", "thstrm_dt": "2025.01.01 ~ 2025.12.31", "thstrm_amount": "1,000",
            "thstrm_add_amount": "1,000", "frmtrm_nm": "제 56 기", "frmtrm_dt": "2024.01.01 ~ 2024.12.31",
            "frmtrm_amount": "900", "frmtrm_q_nm": "", "frmtrm_q_amount": "", "frmtrm_add_amount": "900",
            "bfefrmtrm_nm": "제 55 기", "bfefrmtrm_amount": "800", "ord": "12", "currency": "KRW",
        }]})

    monkeypatch.setattr(company, "_transport", transport)
    result = company.get_feature("dart_financials", {"corpCode": "00126380", "reportYear": "2025", "reportCode": "11011", "fsDiv": "CFS"}, dart_api_key="a" * 40)
    row = result["rows"][0]
    assert result["source"] == "dart" and result["status"] == "snapshot" and result["complete"] is True
    assert result["scope"] == {
        "provider": "OpenDART", "corpCode": "00126380", "businessYear": "2025", "reportCode": "11011",
        "reportKind": "annual report", "fsDiv": "CFS", "statementScope": "consolidated", "returnedRows": 1,
    }
    assert row["accountName"] == "매출액" and row["currency"] == "KRW"
    assert row["currentDate"] == "2025.01.01 ~ 2025.12.31" and row["currentAmount"] == "1,000"
    assert row["previousAmount"] == "900" and row["officialURL"] == "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260330000001"
    assert "derived" in result["note"] and len(calls) == 1


def test_dart_financials_distinguish_no_data_from_malformed_or_provider_error(monkeypatch):
    def request(payload):
        monkeypatch.setattr(company, "_transport", lambda *_args, **_kwargs: _json(payload))
        return company.get_feature("dart_financials", {"corpCode": "00126380", "reportYear": "2025", "reportCode": "11013", "fsDiv": "OFS"}, dart_api_key="a" * 40)

    no_data = request({"status": "013", "message": "no data"})
    malformed = request({"status": "000", "list": {}})
    provider_error = request({"status": "010"})
    assert no_data["status"] == "missing" and no_data["complete"] is True and no_data["rows"] == []
    assert malformed["status"] == "error" and malformed["complete"] is False and malformed["rows"] == []
    assert provider_error["status"] == "error" and provider_error["complete"] is False and provider_error["rows"] == []


def test_dart_financial_row_cap_is_truthful_at_the_1000_1001_boundary(monkeypatch):
    def payload(count: int) -> dict:
        return {"status": "000", "list": [
            {"rcept_no": f"202601{index:08d}", "account_nm": f"Account {index}"}
            for index in range(count)
        ]}

    def request(count: int) -> dict:
        monkeypatch.setattr(company, "_transport", lambda *_args, **_kwargs: _json(payload(count)))
        company._clear_caches_for_tests()
        return company.get_feature(
            "dart_financials",
            {"corpCode": "00126380", "reportYear": "2025", "reportCode": "11011", "fsDiv": "CFS"},
            dart_api_key="a" * 40,
        )

    exactly_1000 = request(1000)
    truncated_1001 = request(1001)

    assert len(exactly_1000["rows"]) == 1000 and exactly_1000["complete"] is True
    assert "truncated" not in exactly_1000["note"]
    assert len(truncated_1001["rows"]) == 1000 and truncated_1001["complete"] is False
    assert truncated_1001["scope"]["availableRows"] == 1001
    assert truncated_1001["scope"]["displayLimit"] == 1000
    assert "Displayed 1000 of 1001 provider rows" in truncated_1001["note"]


def test_invalid_params_and_arbitrary_urls_fail_before_transport(monkeypatch):
    sent: list[str] = []
    monkeypatch.setattr(company, "_transport", lambda url, **_kwargs: sent.append(url) or b"{}")
    with pytest.raises(ValueError):
        company.get_feature("sec_filings", {"url": "https://example.invalid"}, sec_user_agent=SEC_AGENT)
    with pytest.raises(ValueError):
        company.get_feature("sec_filings", {"cik": "320193"}, sec_user_agent="contact@example.invalid")
    with pytest.raises(ValueError, match=r"English \(ASCII\) application name"):
        company.get_feature("sec_filings", {"cik": "320193"}, sec_user_agent="키움 도구 support@example.invalid")
    with pytest.raises(ValueError):
        company.get_feature("sec_filings", {"cik": "320193", "secUserAgent": SEC_AGENT}, sec_user_agent=SEC_AGENT)
    with pytest.raises(ValueError):
        company.get_feature("dart_disclosures", {"corpCode": "bad", "reportPeriod": "2026"}, dart_api_key="a" * 40)
    with pytest.raises(ValueError):
        company._fetch_json("https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json?next=https://example.invalid", headers={}, max_bytes=32)
    with pytest.raises(ValueError):
        company._fetch_json("https://opendart.fss.or.kr/api/list.json?arbitrary=value", headers={}, max_bytes=32)
    assert sent == []
