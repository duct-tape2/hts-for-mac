"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { formatReceivedAt } from "@/lib/format";
import {
  analysisScopeText,
  defaultAnalysisParameters,
  normalizeAnalysisParameters,
  parseAnalysisFeatures,
  parseAnalysisPayload,
  toAnalysisCsv,
  type AnalysisColumn,
  type AnalysisFeature,
  type AnalysisPayload,
  type AnalysisRow,
} from "@/lib/analysisFeatures";
import type { Instrument } from "@/lib/types";
import "./analysisExplorer.css";

export type AnalysisExplorerProps = {
  instrument: Instrument;
  initialFeature?: string;
  active?: boolean;
  refreshKey?: number;
  onPick?: (instrument: Instrument) => void;
  onFeatureChange?: (featureId: string) => void;
};

type Sort = { key: string; direction: "asc" | "desc" } | null;
type ResultState = { key: string; loading: boolean; payload: AnalysisPayload | null; error: string | null };

const emptyResult: ResultState = { key: "", loading: false, payload: null, error: null };

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function requestError(response: Response) {
  return response.ok ? null : new Error(`HTTP ${response.status}`);
}

function featureIdentity(instrument: Instrument) {
  return [instrument.market, instrument.stkCd, instrument.listingVenue, instrument.stexTp, instrument.environment].join(":");
}

const unitNames: Record<string, string> = { KRW: "원", USD: "달러", shares: "주", percent: "%", thousandShares: "천주", millionKRW: "백만원", thousandUSD: "천달러", ratio: "배" };
function unitLabel(unit: string) { return unitNames[unit] ?? unit; }
function unitSummary(columns: AnalysisColumn[]) {
  const units = [...new Set(columns.map((column) => column.unit).filter((unit): unit is string => Boolean(unit)))];
  return units.length ? units.map(unitLabel).join(" · ") : "없음";
}
function displayNote(note: string) {
  return note === "pagination capped at 5 pages" ? "최대 5페이지까지 조회한 일부 결과" : note || "안내 없음";
}
function statusLabel(payload: AnalysisPayload) {
  const status = { snapshot: "스냅샷", missing: "자료 없음", error: "오류", fixture: "고정 자료", "setup-required": "설정 필요" }[payload.status];
  return `${status} · ${payload.complete ? "수신 완료" : "일부 수신"}`;
}
function officialLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !["www.sec.gov", "data.sec.gov", "dart.fss.or.kr"].includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

function formatValue(value: unknown, column: AnalysisColumn) {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "number") {
    if (typeof value === "string" && /^(time|tradeTime|executionTime)$/.test(column.key) && /^\d{6}$/.test(value)) return `${value.slice(0, 2)}:${value.slice(2, 4)}:${value.slice(4)}`;
    return String(value);
  }
  const signed = /(?:change|pct|rate|return|net|diff|flow|profit|loss)/i.test(column.key);
  const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 }).format(value);
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${number}${["%", "percent"].includes(column.unit ?? "") ? "%" : ""}`;
}

function valueClass(value: unknown, column: AnalysisColumn) {
  if (typeof value !== "number" || !/(?:change|pct|rate|return|net|diff|flow|profit|loss)/i.test(column.key)) return "";
  return value > 0 ? "classic-up" : value < 0 ? "classic-down" : "";
}

function compareRows(left: AnalysisRow, right: AnalysisRow, column: AnalysisColumn, direction: NonNullable<Sort>["direction"]) {
  const a = left[column.key];
  const b = right[column.key];
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  const compared = column.numeric && typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b), "ko");
  return direction === "asc" ? compared : -compared;
}

function filteredRows(payload: AnalysisPayload | null, query: string, sort: Sort) {
  if (!payload) return [];
  const search = query.trim().toLocaleLowerCase();
  const rows = payload.rows.filter((row) => {
    if (!search) return true;
    return payload.columns.some((column) => String(row[column.key] ?? "").toLocaleLowerCase().includes(search)) ||
      row.instrument?.stkCd.toLocaleLowerCase().includes(search) || row.instrument?.stkNm.toLocaleLowerCase().includes(search);
  });
  if (!sort) return rows;
  const column = payload.columns.find((candidate) => candidate.key === sort.key);
  return column ? [...rows].sort((a, b) => compareRows(a, b, column, sort.direction)) : rows;
}

function missingRequiredParameters(feature: AnalysisFeature | null, values: Record<string, string>) {
  if (!feature) return [];
  return feature.parameters.filter((parameter) => feature.requiredParameters.includes(parameter.key) && !(values[parameter.key] ?? "").trim());
}

export function AnalysisExplorer({
  instrument,
  initialFeature,
  active = true,
  refreshKey = 0,
  onPick,
  onFeatureChange,
}: AnalysisExplorerProps) {
  const [features, setFeatures] = useState<AnalysisFeature[]>([]);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [featureLoading, setFeatureLoading] = useState(false);
  const [featureId, setFeatureId] = useState("");
  const [draftParameters, setDraftParameters] = useState<Record<string, string>>({});
  const [submittedParameters, setSubmittedParameters] = useState<Record<string, string>>({});
  const [parameterFeatureId, setParameterFeatureId] = useState("");
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [requestNonce, setRequestNonce] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(0);
  const [result, setResult] = useState<ResultState>(emptyResult);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const featureRequest = useRef(0);
  const resultRequest = useRef(0);

  const compatibleFeatures = useMemo(() => features.filter((feature) => feature.market === instrument.market), [features, instrument.market]);
  const selectedFeature = useMemo(() => compatibleFeatures.find((feature) => feature.id === featureId) ?? null, [compatibleFeatures, featureId]);
  const missingSubmittedParameters = missingRequiredParameters(selectedFeature, submittedParameters);
  const missingDraftParameters = missingRequiredParameters(selectedFeature, draftParameters);
  const parametersReady = Boolean(
    selectedFeature
    && parameterFeatureId === selectedFeature.id
    && selectedFeature.parameters.every((parameter) => Object.hasOwn(submittedParameters, parameter.key))
    && missingSubmittedParameters.length === 0,
  );

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const requestId = ++featureRequest.current;
    setFeatureLoading(true);
    setFeatureError(null);
    void (async () => {
      try {
        const response = await fetch("/api/analysis/features", { signal: controller.signal, credentials: "omit", headers: { Accept: "application/json" } });
        const failure = requestError(response);
        if (failure) throw failure;
        const parsed = parseAnalysisFeatures(await response.json());
        if (requestId === featureRequest.current) setFeatures(parsed);
      } catch (error) {
        if (!isAbort(error) && requestId === featureRequest.current) setFeatureError("분석 기능 목록을 불러오지 못했습니다.");
      } finally {
        if (requestId === featureRequest.current) setFeatureLoading(false);
      }
    })();
    return () => controller.abort();
  }, [active]);

  useEffect(() => {
    if (!compatibleFeatures.length) {
      setFeatureId("");
      return;
    }
    setFeatureId((current) => {
      if (compatibleFeatures.some((feature) => feature.id === current)) return current;
      return compatibleFeatures.some((feature) => feature.id === initialFeature) ? initialFeature! : compatibleFeatures[0].id;
    });
  }, [compatibleFeatures, initialFeature]);

  useEffect(() => {
    if (!selectedFeature) return;
    const defaults = defaultAnalysisParameters(selectedFeature);
    setDraftParameters(defaults);
    setSubmittedParameters(defaults);
    setParameterFeatureId(selectedFeature.id);
    setSubmissionError(null);
    setResult(emptyResult);
    setQuery("");
    setSort(null);
    setFocusedId(null);
  }, [selectedFeature?.id]);

  useEffect(() => {
    if (!active || !selectedFeature) return;
    const timer = window.setInterval(() => setAutoRefresh((current) => current + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [active, selectedFeature?.id]);

  const parameterKey = useMemo(() => JSON.stringify(Object.entries(submittedParameters).sort(([a], [b]) => a.localeCompare(b))), [submittedParameters]);
  const requestedParameters = useMemo(() => Object.fromEntries(JSON.parse(parameterKey) as Array<[string, string]>), [parameterKey]);
  const requestKey = selectedFeature
    ? [featureIdentity(instrument), selectedFeature.id, parameterKey, refreshKey, requestNonce, autoRefresh].join("|")
    : "";

  useEffect(() => {
    if (!active || !selectedFeature || !parametersReady || selectedFeature.market !== instrument.market) return;
    const controller = new AbortController();
    const requestId = ++resultRequest.current;
    setResult({ key: requestKey, loading: true, payload: null, error: null });
    void (async () => {
      try {
        const values = normalizeAnalysisParameters(selectedFeature, requestedParameters);
        const params = new URLSearchParams({
          stkCd: instrument.stkCd,
          listingVenue: instrument.listingVenue,
          stexTp: instrument.stexTp,
          ...values,
        });
        const response = await fetch(`/api/analysis/${encodeURIComponent(selectedFeature.id)}?${params.toString()}`, {
          signal: controller.signal,
          credentials: "omit",
          headers: { Accept: "application/json" },
        });
        const failure = requestError(response);
        if (failure) throw failure;
        const payload = parseAnalysisPayload(await response.json(), { ...instrument, featureId: selectedFeature.id });
        if (requestId === resultRequest.current) setResult({ key: requestKey, loading: false, payload, error: null });
      } catch (error) {
        if (!isAbort(error) && requestId === resultRequest.current) {
          setResult({ key: requestKey, loading: false, payload: null, error: error instanceof Error ? error.message : "분석 자료를 받지 못했습니다." });
        }
      }
    })();
    return () => controller.abort();
  }, [active, instrument.environment, instrument.listingVenue, instrument.market, instrument.stexTp, instrument.stkCd, parametersReady, refreshKey, requestKey, requestedParameters, selectedFeature]);

  const payload = result.key === requestKey ? result.payload : null;
  const rows = useMemo(() => filteredRows(payload, query, sort), [payload, query, sort]);

  useEffect(() => {
    if (!focusedId || !rows.some((row) => row.id === focusedId)) setFocusedId(null);
  }, [focusedId, rows]);

  function submitParameters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFeature) return;
    if (missingDraftParameters.length) {
      setSubmissionError(`필수 입력: ${missingDraftParameters.map((parameter) => parameter.label).join(", ")} 값을 입력하세요.`);
      return;
    }
    try {
      const next = normalizeAnalysisParameters(selectedFeature, draftParameters);
      setSubmittedParameters(next);
      setSubmissionError(null);
      setRequestNonce((current) => current + 1);
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : "조회 조건이 올바르지 않습니다.");
    }
  }

  function chooseFeature(nextId: string) {
    setFeatureId(nextId);
    onFeatureChange?.(nextId);
  }

  function changeSort(key: string) {
    setSort((current) => current?.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" });
  }

  function navigateRows(event: KeyboardEvent<HTMLTableElement>) {
    // Column controls and links retain their own Enter/arrow semantics.
    if (event.target !== event.currentTarget) return;
    if (!rows.length) return;
    const currentIndex = focusedId ? rows.findIndex((row) => row.id === focusedId) : -1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = currentIndex < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, currentIndex + delta));
      setFocusedId(rows[nextIndex].id);
    } else if (event.key === "Enter") {
      const selected = rows.find((row) => row.id === focusedId) ?? rows[0];
      if (selected.instrument) {
        event.preventDefault();
        onPick?.(selected.instrument);
      }
    }
  }

  async function copyRows() {
    if (!payload) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(toAnalysisCsv(payload, rows));
      setCopyError(null);
    } catch {
      setCopyError("클립보드에 복사하지 못했습니다.");
    }
  }

  function exportRows() {
    if (!payload) return;
    const blob = new Blob([toAnalysisCsv(payload, rows)], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `analysis-${payload.featureId}.csv`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  if (!active) return <div className="analysis-explorer classic-empty">비활성 패널입니다. 조회를 중지했습니다.</div>;

  return (
    <section className="analysis-explorer" aria-label="분석 탐색">
      <div className="analysis-explorer-instrument">연동 종목 <strong>{instrument.stkNm}</strong> {instrument.stkCd} · {instrument.market} · {instrument.currency}</div>
      <div className="classic-toolbar analysis-explorer-toolbar">
        <label>분석 기능
          <select aria-label="분석 기능" value={featureId} onChange={(event) => chooseFeature(event.target.value)} disabled={featureLoading || compatibleFeatures.length === 0}>
            {compatibleFeatures.map((feature) => <option key={feature.id} value={feature.id}>{feature.title}</option>)}
          </select>
        </label>
        {selectedFeature && <span className="analysis-explorer-description" title={selectedFeature.description}>{selectedFeature.description}</span>}
        <button className="classic-button" type="button" onClick={() => setRequestNonce((current) => current + 1)} disabled={!selectedFeature || !parametersReady || result.loading}>새로고침</button>
      </div>

      {featureLoading && !features.length && <p className="classic-empty">분석 기능을 불러오는 중…</p>}
      {featureError && <p className="classic-error" role="alert">{featureError}</p>}
      {!featureLoading && !featureError && !compatibleFeatures.length && <p className="classic-empty">현재 시장을 지원하는 분석 기능이 없습니다.</p>}

      {selectedFeature && <form className="analysis-explorer-parameters" onSubmit={submitParameters}>
        {selectedFeature.parameters.map((parameter) => {
          const required = selectedFeature.requiredParameters.includes(parameter.key);
          return <label key={parameter.key}>{parameter.label}{required && <span aria-hidden="true"> · 필수</span>}
          {parameter.type === "select" ? (
            <select aria-label={parameter.label} aria-required={required} value={draftParameters[parameter.key] ?? ""} onChange={(event) => setDraftParameters((current) => ({ ...current, [parameter.key]: event.target.value }))}>
              {parameter.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ) : (
            <input aria-label={parameter.label} aria-required={required} type={parameter.type} maxLength={parameter.maxLength ?? 120} value={draftParameters[parameter.key] ?? ""} onChange={(event) => setDraftParameters((current) => ({ ...current, [parameter.key]: event.target.value }))} />
          )}
        </label>;
        })}
        <button className="classic-button" type="submit">조회</button>
        {missingDraftParameters.length > 0 && <p className="analysis-explorer-guidance" role="status">필수 입력: {missingDraftParameters.map((parameter) => parameter.label).join(", ")} 값을 입력한 뒤 조회하세요.</p>}
        <label className="analysis-explorer-search">수신 행 검색
          <input aria-label="수신 행 검색" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="종목·값" />
        </label>
      </form>}
      {submissionError && <p className="classic-error" role="alert">{submissionError}</p>}

      {result.loading && <p className="classic-empty">분석 자료를 불러오는 중…</p>}
      {result.error && !result.loading && <p className="classic-error" role="alert">{result.error}</p>}
      {payload && <>
        <div className="classic-statusline analysis-explorer-status">
          <span title={`제공 기준: ${payload.asOf ? formatReceivedAt(payload.asOf) : "미상"}`}>출처: {payload.source}</span>
          <span>수신: {formatReceivedAt(payload.receivedAt)}</span>
          <span title={displayNote(payload.note)}>상태: {statusLabel(payload)} · {displayNote(payload.note)}</span>
          <span>단위: {unitSummary(payload.columns)}</span>
        </div>
        <div className="analysis-explorer-scope">
          <details className="analysis-explorer-details">
            <summary>조회 기준·상세</summary>
            <div className="analysis-explorer-details-content">
              <span>조회 조건: {analysisScopeText(payload.parameters ?? submittedParameters)}</span>
              <span>범위: {analysisScopeText(payload.scope)}</span>
            </div>
          </details>
          <div className="analysis-explorer-actions">
            <button className="classic-button" type="button" onClick={() => void copyRows()} disabled={!rows.length}>CSV 복사</button>
            <button className="classic-button" type="button" onClick={exportRows} disabled={!rows.length}>CSV 저장</button>
          </div>
        </div>
        {copyError && <p className="classic-error" role="alert">{copyError}</p>}
        {payload.status === "setup-required" && <p className="analysis-explorer-guidance">작업공간 ▾ → 회사·공시 설정에서 제공자 정보를 등록한 뒤 다시 조회하세요.</p>}
        {payload.status === "missing" && <p className="classic-empty">수신 자료가 없습니다. {payload.note}</p>}
        {payload.status === "error" && <p className="classic-error" role="alert">{payload.note || "분석 자료를 제공하지 못했습니다."}</p>}
        {payload.status !== "setup-required" && payload.status !== "missing" && payload.status !== "error" && <div className="classic-grid-scroll analysis-explorer-grid-wrap">
          <table className="classic-grid analysis-explorer-grid" role="grid" aria-label={payload.title} tabIndex={0} onKeyDown={navigateRows}>
            <thead><tr>{payload.columns.map((column) => <th key={column.key} className={column.numeric ? "classic-number" : ""} aria-sort={sort?.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
              <button className="classic-column-button" type="button" onClick={() => changeSort(column.key)}>{column.label}{column.unit ? ` (${unitLabel(column.unit)})` : ""}</button>
            </th>)}</tr></thead>
            <tbody>{rows.length ? rows.map((row) => <tr key={row.id} className={`${focusedId === row.id ? "classic-selected" : ""} ${row.instrument ? "analysis-explorer-row-link" : ""}`} onClick={() => { setFocusedId(row.id); if (row.instrument) onPick?.(row.instrument); }}>
              {payload.columns.map((column) => <td key={column.key} className={`${column.numeric ? "classic-number" : ""} ${valueClass(row[column.key], column)}`}>{officialLink(row[column.key]) ? <a href={officialLink(row[column.key])!} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>공식 원문 ↗</a> : formatValue(row[column.key], column)}</td>)}
            </tr>) : <tr><td className="classic-empty-cell" colSpan={payload.columns.length}>수신한 행에서 일치하는 자료가 없습니다.</td></tr>}</tbody>
          </table>
        </div>}
      </>}
    </section>
  );
}
