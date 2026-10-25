import { describe, expect, it } from "vitest";
import { CHART_TOOLS_STORAGE_KEY } from "@/lib/chartAnnotations";
import {
  PERSONAL_ANALYSIS_BACKUP_MAX_BYTES,
  createPersonalAnalysisBackup,
  parsePersonalAnalysisBackup,
  restorePersonalAnalysisBackup,
} from "@/lib/personalAnalysisBackup";

function storage(failKey?: string) {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (key === failKey) throw new Error("write failure"); values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const scope = {
  drawings: [{ id: "line-1", kind: "horizontal", start: { time: "20261025", price: 100 } }],
  templates: [],
};

function backup(notes = [{ market: "KR", stkCd: "005930", text: "관찰 메모" }], scopes: Record<string, unknown> = { "fixture|KR|005930|KOSPI|KRX|KRW|D": scope }) {
  return { version: 1, notes, chartTools: { version: 1, scopes } };
}

describe("personal analysis backup", () => {
  it("exports only validated notes and chart tools, never unrelated browser values", () => {
    const local = storage();
    local.setItem("hts-note:KR:005930", "검증 메모");
    local.setItem("apiKey", "do-not-export");
    local.setItem(CHART_TOOLS_STORAGE_KEY, JSON.stringify({ version: 1, scopes: { "fixture|KR|005930|KOSPI|KRX|KRW|D": { ...scope, updatedAt: 1 } } }));
    const saved = createPersonalAnalysisBackup(local);
    expect(saved.notes).toEqual([{ market: "KR", stkCd: "005930", text: "검증 메모" }]);
    expect(JSON.stringify(saved)).not.toContain("do-not-export");
    expect(Object.keys(saved.chartTools.scopes)).toHaveLength(1);
  });

  it("scans all bounded browser keys instead of truncating notes after unrelated entries", () => {
    const local = storage();
    for (let index = 0; index < 700; index++) local.setItem(`unrelated-${index}`, "x");
    local.setItem("hts-note:KR:005930", "뒤에 있는 메모");
    expect(createPersonalAnalysisBackup(local).notes).toEqual([{ market: "KR", stkCd: "005930", text: "뒤에 있는 메모" }]);
  });

  it("backs up the same alphanumeric six-character KR identifiers accepted by the instrument validator", () => {
    const local = storage();
    local.setItem("hts-note:KR:A12B34", "알파벳 코드 메모");

    expect(createPersonalAnalysisBackup(local).notes).toEqual([{ market: "KR", stkCd: "A12B34", text: "알파벳 코드 메모" }]);
  });

  it("accepts an empty drawing/template scope as valid backup state", () => {
    const emptyScope = { drawings: [], templates: [] };
    const scopeKey = "fixture|KR|005930|KOSPI|KRX|KRW|D";
    const parsed = parsePersonalAnalysisBackup(JSON.stringify(backup([], { [scopeKey]: emptyScope })));
    const local = storage();
    local.setItem(CHART_TOOLS_STORAGE_KEY, JSON.stringify({ version: 1, scopes: { [scopeKey]: { ...emptyScope, updatedAt: 1 } } }));

    expect(parsed.chartTools.scopes[scopeKey]).toEqual(emptyScope);
    expect(createPersonalAnalysisBackup(local).chartTools.scopes[scopeKey]).toEqual(emptyScope);
  });

  it("fails rather than silently exporting an incomplete note or corrupt chart collection", () => {
    const tooMany = storage();
    for (let index = 0; index <= 500; index++) tooMany.setItem(`hts-note:US:A${index}`, "메모");
    expect(() => createPersonalAnalysisBackup(tooMany)).toThrow("500개");
    const corruptCharts = storage();
    corruptCharts.setItem(CHART_TOOLS_STORAGE_KEY, "{not json");
    expect(() => createPersonalAnalysisBackup(corruptCharts)).toThrow("손상");
  });

  it("rejects extra secret-shaped fields and oversized files", () => {
    expect(() => parsePersonalAnalysisBackup(JSON.stringify({ ...backup(), apiKey: "secret" }))).toThrow("스키마");
    expect(() => parsePersonalAnalysisBackup(`"${"x".repeat(PERSONAL_ANALYSIS_BACKUP_MAX_BYTES)}"`)).toThrow("1 MiB");
  });

  it("merges unrelated existing data while importing conflicts intentionally", () => {
    const local = storage();
    local.setItem("hts-note:US:AAPL", "기존 미국 메모");
    local.setItem("hts-note:KR:005930", "이전 메모");
    local.setItem(CHART_TOOLS_STORAGE_KEY, JSON.stringify({ version: 1, scopes: {
      "fixture|US|AAPL|NASDAQ|ND|USD|D": { ...scope, updatedAt: 1 },
      "fixture|KR|005930|KOSPI|KRX|KRW|D": { drawings: [{ id: "old", kind: "vertical", start: { time: "20261025", price: 0 } }], templates: [], updatedAt: 1 },
    } }));
    restorePersonalAnalysisBackup(local, parsePersonalAnalysisBackup(JSON.stringify(backup())));
    expect(local.getItem("hts-note:US:AAPL")).toBe("기존 미국 메모");
    expect(local.getItem("hts-note:KR:005930")).toBe("관찰 메모");
    const charts = JSON.parse(local.getItem(CHART_TOOLS_STORAGE_KEY) || "{}");
    expect(charts.scopes["fixture|US|AAPL|NASDAQ|ND|USD|D"]).toBeDefined();
    expect(charts.scopes["fixture|KR|005930|KOSPI|KRX|KRW|D"].drawings.map((item: { id: string }) => item.id)).toEqual(["old", "line-1"]);
  });

  it("rolls back earlier note writes when a later restore write fails", () => {
    const local = storage("hts-note:US:AAPL");
    local.setItem("hts-note:KR:005930", "원래 메모");
    const incoming = parsePersonalAnalysisBackup(JSON.stringify(backup([
      { market: "KR", stkCd: "005930", text: "새 메모" },
      { market: "US", stkCd: "AAPL", text: "실패할 메모" },
    ], {})));
    expect(() => restorePersonalAnalysisBackup(local, incoming)).toThrow("되돌렸습니다");
    expect(local.getItem("hts-note:KR:005930")).toBe("원래 메모");
    expect(local.getItem("hts-note:US:AAPL")).toBeNull();
  });
});
