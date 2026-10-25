"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ColorType, LineSeries, createChart } from "lightweight-charts";
import type { IChartApi, Time } from "lightweight-charts";
import { TickerSearch } from "@/components/TickerSearch";
import { api, isAbortError } from "@/lib/api";
import { alignComparisonSeries, comparisonInstrumentKey } from "@/lib/chartComparison";
import { sameFeed } from "@/lib/types";
import type { ChartPayload, Instrument } from "@/lib/types";
import "./comparisonChart.css";

type Props = {
  instrument: Instrument;
  active?: boolean;
  refreshKey?: number;
  companions?: Instrument[];
  onCompanionsChange?: (items: Instrument[]) => void;
};

type HistoryState = { payload: ChartPayload | null; error: string; loading: boolean };

const COLORS = ["#315e91", "#b0265a", "#4d7d33", "#7b5aa6"];
const statusLabels: Record<ChartPayload["status"], string> = {
  snapshot: "스냅샷",
  live: "실시간",
  stale: "지연",
  missing: "미수신",
  error: "오류 응답",
};

function dailyTime(date: string): Time {
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(4, 6)), day: Number(date.slice(6, 8)) };
}

function displayDate(date: string | null) {
  return date ? `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}` : "—";
}

function receivedStatus(result: HistoryState | undefined) {
  if (result?.loading) return result.payload ? "수신 상태: 이전 수신 자료 · 갱신 중" : "수신 상태: 조회 중";
  if (result?.error) return result.payload ? "수신 상태: 이전 수신 자료 · 갱신 실패" : "수신 상태: 조회 오류";
  const payload = result?.payload;
  if (!payload) return "수신 상태: 대기";
  if (payload.status === "missing" || payload.status === "error") return `수신 상태: ${statusLabels[payload.status]}`;
  return `수신 상태: ${statusLabels[payload.status]} · ${payload.complete ? "완결" : "일부 수신"}`;
}

function receivedNote(result: HistoryState | undefined) {
  if (result?.error) return `갱신 실패: ${result.error}`;
  if (result?.payload) return result.payload.note || "안내 없음";
  return result?.loading ? "일별 종가 요청 중" : "수신 자료 없음";
}

function receivedTitle(result: HistoryState | undefined) {
  const payload = result?.payload;
  return payload ? [`출처: ${payload.source}`, `수신: ${payload.receivedAt ?? "미상"}`, receivedNote(result)].join(" · ") : receivedNote(result);
}

function comparisonInstruments(primary: Instrument, companions: readonly Instrument[]) {
  const seen = new Set([comparisonInstrumentKey(primary)]);
  return [primary, ...companions.flatMap((item) => {
    const key = comparisonInstrumentKey(item);
    if (item.environment !== primary.environment || sameFeed(item, primary) || seen.has(key)) return [];
    seen.add(key);
    return [item];
  }).slice(0, 3)];
}

function sameComparisonInstruments(left: readonly Instrument[], right: readonly Instrument[]) {
  return left.length === right.length && left.every((item, index) => comparisonInstrumentKey(item) === comparisonInstrumentKey(right[index]));
}

export function ComparisonChart({ instrument, active = true, refreshKey = 0, companions = [], onCompanionsChange }: Props) {
  const primaryKey = comparisonInstrumentKey(instrument);
  const companionKey = useMemo(() => companions.map(comparisonInstrumentKey).join(","), [companions]);
  const [instruments, setInstruments] = useState<Instrument[]>(() => comparisonInstruments(instrument, companions));
  const [histories, setHistories] = useState<Record<string, HistoryState>>({});
  const [searchMarket, setSearchMarket] = useState(instrument.market);
  const [search, setSearch] = useState("");
  const [selectionNote, setSelectionNote] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const next = comparisonInstruments(instrument, companions);
    setInstruments((current) => sameComparisonInstruments(current, next) ? current : next);
    setSearchMarket(instrument.market);
    setSearch("");
    setSelectionNote("");
  }, [companionKey, primaryKey]);

  const instrumentKey = useMemo(() => instruments.map(comparisonInstrumentKey).join(","), [instruments]);

  useEffect(() => {
    if (!active || instruments.length === 0) return;
    const controller = new AbortController();
    const request = ++requestRef.current;
    setHistories((previous) => Object.fromEntries(instruments.map((item) => {
      const key = comparisonInstrumentKey(item);
      return [key, { payload: previous[key]?.payload ?? null, error: "", loading: true }];
    })));
    for (const item of instruments) {
      const key = comparisonInstrumentKey(item);
      void api.chart(item, "D", controller.signal)
        .then((payload) => {
          if (controller.signal.aborted || request !== requestRef.current || !sameFeed(payload, item)) return;
          setHistories((previous) => ({ ...previous, [key]: { payload, error: "", loading: false } }));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || request !== requestRef.current || isAbortError(error)) return;
          setHistories((previous) => ({ ...previous, [key]: { payload: previous[key]?.payload ?? null, error: error instanceof Error ? error.message : "일별 시세를 불러오지 못했습니다.", loading: false } }));
        });
    }
    return () => controller.abort();
  }, [active, instrumentKey, instruments, refreshKey]);

  const alignment = useMemo(() => alignComparisonSeries(instruments.map((item) => ({ instrument: item, payload: histories[comparisonInstrumentKey(item)]?.payload ?? null }))), [histories, instruments]);
  const currencies = useMemo(() => [...new Set(instruments.map((item) => item.currency))], [instruments]);
  const unavailable = instruments.filter((item) => !alignment.receivedKeys.includes(comparisonInstrumentKey(item)));
  const partial = instruments.filter((item) => {
    const payload = histories[comparisonInstrumentKey(item)]?.payload;
    return payload && payload.status !== "missing" && payload.status !== "error" && !payload.complete;
  });
  const retainedAfterError = instruments.filter((item) => {
    const state = histories[comparisonInstrumentKey(item)];
    return Boolean(state?.payload && state.error);
  });
  const completeComparison = alignment.series.length === instruments.length;
  const canRenderComparison = alignment.series.length > 0 && (instruments.length === 1 || completeComparison);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || alignment.series.length === 0) return;
    const chart: IChartApi = createChart(host, {
      width: Math.max(host.clientWidth, 1), height: Math.max(host.clientHeight, 1),
      layout: { background: { type: ColorType.Solid, color: "#d8d8d8" }, textColor: "#171717", fontSize: 11, fontFamily: "Consolas, 'Apple SD Gothic Neo', monospace", attributionLogo: true },
      grid: { vertLines: { color: "#f7f7f7" }, horzLines: { color: "#f7f7f7" } },
      rightPriceScale: { borderColor: "#949494", minimumWidth: 58 },
      timeScale: { borderColor: "#949494", timeVisible: true, secondsVisible: false },
    });
    alignment.series.forEach((series, index) => {
      const line = chart.addSeries(LineSeries, { color: COLORS[index % COLORS.length], lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: series.instrument.stkCd });
      const byDate = new Map(series.points.map((point) => [point.date, point.value]));
      line.setData(alignment.unionDates.map((date) => byDate.has(date) ? { time: dailyTime(date), value: byDate.get(date)! } : { time: dailyTime(date) }));
    });
    chart.timeScale().fitContent();
    const resize = () => chart.resize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1));
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(host);
    return () => { observer?.disconnect(); chart.remove(); };
  }, [alignment]);

  function addInstrument(next: Instrument) {
    if (instruments.some((item) => sameFeed(item, next))) {
      setSelectionNote("이미 비교 중인 종목입니다.");
      return;
    }
    if (next.environment !== instrument.environment) {
      setSelectionNote("현재 데이터 환경과 같은 검색 결과만 추가할 수 있습니다.");
      return;
    }
    if (instruments.length >= 4) {
      setSelectionNote("비교는 기준 종목을 포함해 최대 4개입니다.");
      return;
    }
    const updated = [...instruments, next];
    setInstruments(updated);
    onCompanionsChange?.(updated.slice(1));
    setSearch("");
    setSelectionNote("");
  }

  const errors = instruments.flatMap((item) => {
    const error = histories[comparisonInstrumentKey(item)]?.error;
    return error ? [`${item.stkCd}: ${error}`] : [];
  });
  const loading = instruments.some((item) => histories[comparisonInstrumentKey(item)]?.loading);

  return (
    <section className="comparison-chart" aria-label="상대수익률 비교 차트">
      <header className="comparison-chart-toolbar">
        <h2>상대수익률 비교 <small>일별 종가 · 기준 100</small></h2>
        <div className="comparison-chart-search">
          <div role="group" aria-label="비교 종목 검색 시장">
            {(["KR", "US"] as const).map((market) => <button key={market} type="button" aria-pressed={searchMarket === market} onClick={() => setSearchMarket(market)}>{market === "KR" ? "국내" : "미국"}</button>)}
          </div>
          <TickerSearch market={searchMarket} value={search} onChange={setSearch} onPick={addInstrument} placeholder={instruments.length >= 4 ? "최대 4종목" : "비교 종목 검색·추가"} disabled={!active || instruments.length >= 4} />
        </div>
      </header>

      <div className="comparison-chart-legend" aria-label="비교 종목과 수신 상태">
        {instruments.map((item, index) => {
          const key = comparisonInstrumentKey(item);
          const result = histories[key];
          const aligned = alignment.series.find((series) => series.key === key);
          return <span key={key} className="comparison-chart-item">
            <i style={{ backgroundColor: COLORS[index % COLORS.length] }} aria-hidden="true" />
            <span>{item.stkCd} {item.stkNm} · {item.currency}</span>
            {aligned?.missingDates.length ? ` · 수신 누락 ${aligned.missingDates.length}일` : ""}
            <span className="comparison-chart-item-status">{receivedStatus(result)}</span>
            <span className="comparison-chart-item-note" title={receivedTitle(result)}>{receivedNote(result)}</span>
            {index > 0 && <button type="button" onClick={() => { const updated = instruments.filter((candidate) => !sameFeed(candidate, item)); setInstruments(updated); onCompanionsChange?.(updated.slice(1)); }} aria-label={`${item.stkCd} 비교에서 제거`}>×</button>}
          </span>;
        })}
      </div>

      <p className="comparison-chart-scope" role="status">
        {unavailable.length ? `선택 ${instruments.length}종목 중 ${instruments.length - unavailable.length}종목만 비교 가능한 일별 종가를 수신했습니다. ${unavailable.map((item) => item.stkCd).join(", ")}은(는) 미수신 또는 오류여서 전체 비교선을 표시하지 않습니다.` : alignment.baseDate ? `공통 수신 기준일 ${displayDate(alignment.baseDate)} = 100 · 이후 비수신일 가격은 생성하지 않음` : loading ? "선택 종목의 일별 종가를 받는 중…" : "모든 수신 시계열에 공통으로 있는 기준일이 없어 비교선을 그리지 않습니다."}
        {partial.length ? ` · 일부 수신 자료 포함: ${partial.map((item) => item.stkCd).join(", ")}` : ""}
        {retainedAfterError.length ? ` · 갱신 실패 뒤 이전 수신 자료 표시: ${retainedAfterError.map((item) => item.stkCd).join(", ")}` : ""}
        {currencies.length > 1 ? " · KRW/USD는 환산하지 않으며 각 종목의 수익률 지수만 비교" : ` · ${currencies[0] ?? instrument.currency} 가격을 수익률 지수로 표시`}
      </p>

      <div className="comparison-chart-plot">
        {canRenderComparison ? <div ref={hostRef} data-testid="comparison-lightweight-chart" /> : <p className="comparison-chart-empty" role={errors.length ? "alert" : "status"}>{errors[0] || (unavailable.length ? "모든 선택 종목의 비교 가능한 일별 종가를 기다리는 중…" : "비교할 수신 일별 종가를 기다리는 중…")}</p>}
      </div>

      {(errors.length > 0 || selectionNote) && <div className="comparison-chart-notes" role="status">{[...errors, selectionNote].filter(Boolean).join(" · ")}</div>}
      <footer>실제 수신 일별 종가만 사용 · 공급자별 휴장/누락일은 서로 다를 수 있음 · 환율 변환 없음</footer>
    </section>
  );
}
