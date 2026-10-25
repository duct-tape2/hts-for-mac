"use client";
import { useEffect, useState } from "react";
import { api, isAbortError } from "@/lib/api";
import {
  changeClass,
  formatPrice,
  formatReceivedAt,
  formatVol,
} from "@/lib/format";
import { feedKeyOf, sameFeed } from "@/lib/types";
import type { ChartPayload, Instrument, Quote } from "@/lib/types";

export function HistoryPanel({
  instrument,
  refreshKey,
}: {
  instrument: Instrument;
  refreshKey: number;
}) {
  const key = JSON.stringify({ ...feedKeyOf(instrument), refreshKey });
  const [result, setResult] = useState<{
    key: string;
    data: ChartPayload | null;
    error: string;
  }>({ key: "", data: null, error: "" });
  const [page, setPage] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setResult({ key, data: null, error: "" });
    setPage(0);
    api
      .chart(instrument, "D", c.signal)
      .then((data) => {
        if (!c.signal.aborted) setResult({ key, data, error: "" });
      })
      .catch((e) => {
        if (!c.signal.aborted && !isAbortError(e))
          setResult({
            key,
            data: null,
            error: e instanceof Error ? e.message : "시세 조회 실패",
          });
      });
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const data =
    result.key === key && sameFeed(result.data, instrument)
      ? result.data
      : null;
  const pageSize = 100;
  const total = data?.bars.length ?? 0;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(total / pageSize) - 1));
  const end = Math.max(0, total - currentPage * pageSize);
  const visibleBars = data?.bars.slice(Math.max(0, end - pageSize), end).reverse() ?? [];
  function download() {
    if (!data) return;
    const csv =
      "date,open,high,low,close,volume,currency,source,environment\n" +
      data.bars
        .map((b) =>
          [
            b.t,
            b.o,
            b.h,
            b.l,
            b.c,
            b.v ?? "",
            data.currency,
            data.source,
            data.environment,
          ].join(","),
        )
        .join("\n");
    const url = URL.createObjectURL(
      new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${instrument.market}-${instrument.stkCd}-${instrument.environment}-daily.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="analysis-panel" aria-label="일별 시세 데이터">
      <div className="analysis-toolbar">
        <b>{instrument.stkNm}</b>
        <span>일별 OHLCV</span>
        <span className="ml-auto">{data?.bars.length ?? 0}개</span>
        <button className="hts-btn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="더 최근 시세">이전</button>
        <span>{total ? currentPage * pageSize + 1 : 0}–{Math.min(total, (currentPage + 1) * pageSize)}</span>
        <button className="hts-btn" disabled={end <= pageSize} onClick={() => setPage(currentPage + 1)} aria-label="더 오래된 시세">다음</button>
        <button
          className="hts-btn"
          disabled={!data?.bars.length}
          onClick={download}
        >
          CSV 내보내기
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="hts-table">
          <thead>
            <tr>
              <th>일자</th>
              <th>종가</th>
              <th>시가</th>
              <th>고가</th>
              <th>저가</th>
              <th>거래량</th>
            </tr>
          </thead>
          <tbody>
            {visibleBars
              .map((b) => (
                <tr key={b.t}>
                  <td>
                    {b.t.slice(0, 4)}.{b.t.slice(4, 6)}.{b.t.slice(6, 8)}
                  </td>
                  <td className={changeClass(b.c - b.o)}>
                    {formatPrice(b.c, instrument.currency)}
                  </td>
                  <td>{formatPrice(b.o, instrument.currency)}</td>
                  <td className="text-up">
                    {formatPrice(b.h, instrument.currency)}
                  </td>
                  <td className="text-down">
                    {formatPrice(b.l, instrument.currency)}
                  </td>
                  <td>{formatVol(b.v)}</td>
                </tr>
              ))}
          </tbody>
        </table>
        {!data?.bars.length && (
          <p className="panel-empty" role={result.error ? "alert" : "status"}>
            {(result.key === key && result.error) ||
              data?.note ||
              "일별 시세 불러오는 중…"}
          </p>
        )}
      </div>
      <div className="analysis-foot">
        {!data ? "미수신" : data.source === "fixture" ? "합성 테스트 데이터" : "키움 조회 데이터"}{" "}
        · {data?.adjusted ? "수정주가" : "수정 여부 미확인"} ·{" "}
        {data?.complete ? "응답 범위 조회 완료" : "일부 / 조회 중"}
      </div>
    </section>
  );
}

export function DetailsPanel({
  instrument,
  quote,
}: {
  instrument: Instrument;
  quote: Quote | null;
}) {
  const rows = [
    ["종목코드", instrument.stkCd],
    ["상장시장", instrument.listingVenue],
    ["시세 거래소", instrument.quoteVenue],
    ["통화", instrument.currency],
    ["현재가", formatPrice(quote?.last ?? null, instrument.currency)],
    ["전일종가", formatPrice(quote?.prevClose ?? null, instrument.currency)],
    ["시가", formatPrice(quote?.open ?? null, instrument.currency)],
    ["고가", formatPrice(quote?.high ?? null, instrument.currency)],
    ["저가", formatPrice(quote?.low ?? null, instrument.currency)],
    ["거래량", formatVol(quote?.volume ?? null)],
    ["수신 시각", formatReceivedAt(quote?.receivedAt ?? null)],
    [
      "데이터 출처",
      quote?.source === "fixture"
        ? "합성 테스트 데이터"
        : (quote?.source ?? "미수신"),
    ],
  ];
  return (
    <section className="analysis-panel" aria-label="종목 정보">
      <div className="analysis-toolbar">
        <b>{instrument.stkNm}</b>
        <span>{instrument.stkCd}</span>
      </div>
      <dl className="instrument-details">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="analysis-foot">
        {instrument.market === "KR"
          ? "KRX · 현재가는 조회 시점의 스냅샷"
          : "미국 현재가 스냅샷 · 선택 종목 호가 FT"}
      </p>
    </section>
  );
}

export function NotesPanel({ instrument }: { instrument: Instrument }) {
  const key = `hts-note:${instrument.market}:${instrument.stkCd}`;
  const [memo, setMemo] = useState({ key: "", text: "" });
  const [status, setStatus] = useState("");
  useEffect(() => {
    try {
      setMemo({ key, text: localStorage.getItem(key) || "" });
      setStatus("이 기기에 저장");
    } catch {
      setMemo({ key, text: "" });
      setStatus("저장소 접근 불가");
    }
  }, [key]);
  return (
    <section className="analysis-panel" aria-label="종목 분석 메모">
      <div className="analysis-toolbar">
        <b>{instrument.stkNm}</b>
        <span>분석 메모</span>
        <span className="ml-auto">{status}</span>
      </div>
      <textarea
        aria-label={`${instrument.stkCd} 분석 메모`}
        className="analysis-notes"
        placeholder="관찰할 가격, 추세와 확인할 사항을 기록하세요."
        value={memo.key === key ? memo.text : ""}
        onChange={(e) => {
          const text = e.target.value;
          setMemo({ key, text });
          try {
            localStorage.setItem(key, text);
            setStatus("저장됨");
          } catch {
            setStatus("저장 실패");
          }
        }}
      />
    </section>
  );
}
