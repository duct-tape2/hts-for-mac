import { describe, expect, it } from "vitest";
import {
  analysisScopeText,
  defaultAnalysisParameters,
  normalizeAnalysisParameters,
  parseAnalysisFeatures,
  parseAnalysisPayload,
  toAnalysisCsv,
} from "@/lib/analysisFeatures";
import { apple, samsung } from "@/test/fixtures";

const featureResponse = {
  features: [{
    id: "fundamentals",
    title: "기본 분석",
    market: "KR",
    description: "수신된 재무 지표를 표시합니다.",
    parameters: [
      { key: "period", label: "기간", type: "select", default: "annual", options: [{ value: "annual", label: "연간" }, { value: "quarter", label: "분기" }] },
      { key: "limit", label: "행 수", type: "number", default: 10 },
    ],
  }],
};

function validPayload() {
  return {
    featureId: "fundamentals",
    title: "기본 분석",
    market: "KR",
    source: "fixture",
    status: "fixture",
    receivedAt: "2026-10-25T01:02:03Z",
    asOf: "2026-10-24T15:30:00Z",
    note: "fixture result",
    complete: true,
    columns: [{ key: "name", label: "종목", numeric: false }, { key: "changePct", label: "등락률", numeric: true, unit: "%" }],
    rows: [{ id: "005930", name: "삼성전자", changePct: 0, instrument: samsung }],
    scope: { market: "KR" },
    parameters: { period: "annual" },
  };
}

describe("analysis feature contracts", () => {
  it("keeps only declared, valid query parameters", () => {
    const [feature] = parseAnalysisFeatures(featureResponse);
    expect(normalizeAnalysisParameters(feature, { period: "quarter", limit: "25", injected: "ignore" })).toEqual({ period: "quarter", limit: "25" });
    expect(() => normalizeAnalysisParameters(feature, { period: "monthly", limit: "25" })).toThrow("선택값");
    expect(() => normalizeAnalysisParameters(feature, { period: "annual", limit: "1e3" })).toThrow("숫자 형식");
  });

  it("rejects malformed feature declarations", () => {
    expect(() => parseAnalysisFeatures({ features: [{ ...featureResponse.features[0], id: "bad id" }] })).toThrow("올바르지");
    expect(() => parseAnalysisFeatures({ features: [{ ...featureResponse.features[0], parameters: [{ key: "x", label: "x", type: "select", default: "x" }] }] })).toThrow("options");
  });

  it("resolves a server today default in Seoul while retaining an optional blank date", () => {
    const [feature] = parseAnalysisFeatures({
      features: [{ ...featureResponse.features[0], parameters: [
        { key: "date", label: "기준일", type: "date", default: "today" },
        { key: "endDate", label: "종료일", type: "date", default: "" },
      ] }],
    });
    expect(feature.parameters[0].default).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(feature.parameters[0].default).not.toBe("today");
    expect(feature.parameters[1].default).toBe("");
  });

  it("permits only an explicitly declared blank select value", () => {
    const [feature] = parseAnalysisFeatures({
      features: [{ ...featureResponse.features[0], parameters: [
        { key: "exchange", label: "거래소", type: "select", default: "", options: [{ value: "", label: "종목 거래소 사용" }] },
      ] }],
    });
    expect(normalizeAnalysisParameters(feature, { exchange: "" })).toEqual({ exchange: "" });
  });

  it("retains a declared text default longer than 120 characters through parameter serialization", () => {
    const symbols = "ND:AAPL, ".repeat(30).slice(0, -2);
    const [feature] = parseAnalysisFeatures({
      features: [{ ...featureResponse.features[0], parameters: [
        { key: "symbols", label: "관심 종목", type: "text", default: symbols, maxLength: 2048 },
      ] }],
    });

    expect(symbols.length).toBeGreaterThan(120);
    expect(defaultAnalysisParameters(feature)).toEqual({ symbols });
    expect(normalizeAnalysisParameters(feature, {})).toEqual({ symbols });
    expect(normalizeAnalysisParameters(feature, { symbols })).toEqual({ symbols });
    expect(() => parseAnalysisFeatures({
      features: [{ ...featureResponse.features[0], parameters: [{ key: "symbols", label: "관심 종목", type: "text", default: symbols }] }],
    })).toThrow("입력값");
  });

  it("rejects invalid declared parameter length bounds", () => {
    for (const maxLength of [0, -1, 1.5, 2049, "2048"]) {
      expect(() => parseAnalysisFeatures({
        features: [{ ...featureResponse.features[0], parameters: [{ key: "symbols", label: "관심 종목", type: "text", default: "", maxLength }] }],
      })).toThrow("조회 조건 길이");
    }
  });

  it("rejects a returned row whose verified identity falls outside the requested market", () => {
    const payload = validPayload();
    payload.rows[0].instrument = apple;
    expect(() => parseAnalysisPayload(payload, { ...samsung, featureId: "fundamentals" })).toThrow("식별자");
  });

  it("exports received values with formula cells neutralized and metadata retained", () => {
    const payload = validPayload();
    payload.rows[0].name = "=SUM(1,1)";
    const parsed = parseAnalysisPayload(payload, { ...samsung, featureId: "fundamentals" });
    const csv = toAnalysisCsv(parsed);
    expect(csv).toContain('"source","fixture"');
    expect(csv).toContain('"scope","market=KR"');
    expect(csv).toContain('"\'=SUM(1,1)"');
    expect(csv).toContain('"0"');
  });

  it("retains bounded nested provider scope and nonnumeric boolean cells", () => {
    const payload: Record<string, unknown> = validPayload();
    payload.scope = { parameters: { period: "annual" } };
    payload.parameters = { fixture: true };
    (payload.rows as Array<Record<string, unknown>>)[0].name = false;
    const parsed = parseAnalysisPayload(payload, { ...samsung, featureId: "fundamentals" });
    expect(analysisScopeText(parsed.scope)).toBe("parameters={period:annual}");
    expect(analysisScopeText(parsed.parameters)).toBe("fixture=true");
  });
});
