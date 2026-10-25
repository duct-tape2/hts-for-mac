"use client";

import { useEffect, useId, useState } from "react";
import type { KeyboardEvent } from "react";
import type { CaptureColumn, CapturePayload, CaptureRow, CaptureSection } from "@/lib/capture";
import { CaptureChart } from "@/components/capture/CaptureChart";
import { CaptureGrid } from "@/components/capture/CaptureGrid";
import type { Instrument } from "@/lib/types";
import "./captureViews.css";

type Shared = { payload: CapturePayload; active: boolean; onPick: (instrument: Instrument) => void; onSector?: (code: string) => void };
type Cell = string | number | null | undefined;
type InvestorField = { key: string; label: string; tone?: "individual" | "foreign" | "institutional" };

const UNAVAILABLE = "미수신";
const STATUS_LABELS: Record<string, string> = { snapshot: "수신", delayed: "지연", missing: "미수신", error: "오류", fixture: "테스트" };
const KNOWN_SECTOR_NAMES: Record<string, string> = { "001": "종합(KOSPI)", "101": "종합(KOSDAQ)", "201": "KOSPI200" };
const primaryInvestorFields: InvestorField[] = [
  { key: "individual", label: "개인", tone: "individual" },
  { key: "foreign", label: "외국인", tone: "foreign" },
  { key: "institutional", label: "기관계", tone: "institutional" },
];
const detailedInvestorFields: InvestorField[] = [
  { key: "securities", label: "금융투자" }, { key: "insurance", label: "보험" }, { key: "investmentTrust", label: "투신" },
  { key: "bank", label: "은행" }, { key: "pension", label: "종금" }, { key: "fund", label: "연기금" },
  { key: "privateFund", label: "사모펀드" }, { key: "national", label: "국가" }, { key: "otherCorporation", label: "기타법인" },
  { key: "nativeTrmtForeign", label: "내국인대우 외국인" },
];

const newsDateFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const newsClockFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function display(value: Cell, unavailable = UNAVAILABLE, precision?: number) {
  return typeof value === "number" ? value.toLocaleString("ko-KR", { minimumFractionDigits: precision, maximumFractionDigits: precision ?? 4 }) : typeof value === "string" && value.trim() ? value : unavailable;
}

function rowValue(row: CaptureRow | undefined, keys: string[]): Cell {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "string" || typeof value === "number" || value === null) return value;
  }
  return undefined;
}

function direction(value: Cell) {
  return typeof value === "number" ? value > 0 ? "classic-up" : value < 0 ? "classic-down" : "" : "";
}

function newsDate(value: string) {
  if (!value.trim()) return { date: "미상", time: "미상", combined: "발행 시각 미상", dateTime: undefined };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: "미상", time: "미상", combined: "발행 시각 미상", dateTime: undefined };
  return { date: newsDateFormat.format(date), time: newsClockFormat.format(date), combined: `${newsDateFormat.format(date)} ${newsClockFormat.format(date)} KST`, dateTime: value };
}

function displayAsOf(value?: string | null) {
  const raw = value?.trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.replaceAll("-", ".");
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return `${newsDateFormat.format(date)} ${newsClockFormat.format(date)} KST`;
}

function safeNewsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function newsScopeNote(note: string) {
  const trimmed = note.trim();
  const limit = "발행사 RSS의 제목과 제공된 요약만 표시합니다. 기사 본문은 가져오지 않습니다.";
  return trimmed.includes("기사 본문") ? trimmed : [trimmed, limit].filter(Boolean).join(" ");
}

function pick(row: CaptureRow, onPick: (instrument: Instrument) => void) {
  if (row.instrument) onPick(row.instrument);
}

function sectionFor(sections: CaptureSection[], tab: string) {
  const words: Record<string, RegExp> = {
    time: /time|시간/i,
    daily: /daily|일별/i,
    constituents: /constituent|component|구성|종목/i,
  };
  return sections.find((section) => words[tab]?.test(`${section.id} ${section.title}`));
}

function SectionGrid({ section, onPick, onSector }: { section: CaptureSection; onPick: (instrument: Instrument) => void; onSector?: (code: string) => void }) {
  return <CaptureGrid label={section.title} columns={section.columns} rows={section.rows} onPick={(row) => pick(row, onPick)} onSector={onSector} />;
}

function industryTime(value: Cell) {
  const raw = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  const compact = raw.replaceAll(":", "");
  if (!/^\d{6}$/.test(compact)) return raw ? `미확인 (${raw})` : "시각 미확인";
  const [hour, minute, second] = [Number(compact.slice(0, 2)), Number(compact.slice(2, 4)), Number(compact.slice(4, 6))];
  return hour <= 23 && minute <= 59 && second <= 59 ? `${compact.slice(0, 2)}:${compact.slice(2, 4)}:${compact.slice(4, 6)}` : `미확인 (${compact})`;
}

function displayedIndustryTimeSection(section: CaptureSection) {
  const timeColumn = section.columns.find((column) => column.key === "time");
  if (!timeColumn) return section;
  const displayKey = "displayTime";
  return {
    ...section,
    columns: section.columns.map((column) => column === timeColumn ? { ...column, key: displayKey } : column),
    rows: section.rows.map((row) => ({ ...row, [displayKey]: industryTime(rowValue(row, [timeColumn.key])) })),
  };
}

function ScopeNote({ source, status, asOf, note, fallback }: { source?: string; status?: string; asOf?: string | null; note?: string; fallback?: string }) {
  const formattedAsOf = displayAsOf(asOf);
  const metadata = [source && `출처: ${source}`, status && (STATUS_LABELS[status] ?? "확인 필요"), formattedAsOf && `기준: ${formattedAsOf}`].filter(Boolean);
  const messages = [...new Set([note?.trim(), fallback?.trim()].filter((message): message is string => Boolean(message)))];
  return (
    <div className="capture-views-scope-note">
      {metadata.length > 0 && <span>{metadata.join(" · ")}</span>}
      {messages.map((message) => message.length > 150 ? <details key={message}><summary>범위·주의 보기</summary><span>{message}</span></details> : <span key={message}>{message}</span>)}
    </div>
  );
}

function signedNumber(value: Cell, precision = 0, percent = false) {
  if (typeof value !== "number") return display(value);
  const number = display(Math.abs(value), UNAVAILABLE, precision);
  if (percent) return `${value > 0 ? "+" : value < 0 ? "-" : ""}${number}%`;
  return `${value > 0 ? "▲ " : value < 0 ? "▼ " : ""}${number}`;
}

function SummaryTable({ title, rows }: { title: string; rows: { label: string; value: Cell; precision?: number; signed?: "change" | "percent"; tone?: Cell }[] }) {
  return (
    <section className="capture-views-summary-table" aria-label={title}>
      <h4>{title}</h4>
      <table>
        <tbody>
          {rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td className={row.value === undefined || row.value === null ? "capture-views-unknown" : direction(row.tone ?? (row.signed ? row.value : undefined))}>{row.signed ? signedNumber(row.value, row.precision, row.signed === "percent") : display(row.value, UNAVAILABLE, row.precision)}</td></tr>)}
        </tbody>
      </table>
    </section>
  );
}

export function SectorCaptureView({ payload, active, onPick, onSector }: Shared) {
  const time = sectionFor(payload.sections, "time");
  const daily = sectionFor(payload.sections, "daily");
  const constituents = sectionFor(payload.sections, "constituents");
  const knownIds = new Set([time?.id, daily?.id, constituents?.id].filter(Boolean));
  const extraSections = payload.sections.filter((section) => !knownIds.has(section.id));
  const initialTab = time ? "time" : daily ? "daily" : payload.bars.length ? "chart" : constituents ? "constituents" : extraSections[0] ? `section:${extraSections[0].id}` : "time";
  const [tab, setTab] = useState(initialTab);
  const selectedSection = tab === "time" ? time : tab === "daily" ? daily : tab === "constituents" ? constituents : tab.startsWith("section:") ? extraSections.find((section) => `section:${section.id}` === tab) : undefined;
  const displayedSection = selectedSection === time && selectedSection ? displayedIndustryTimeSection(selectedSection) : selectedSection;
  const summary = payload.rows[0];
  const sectorCode = typeof summary?.sectorCode === "string" ? summary.sectorCode : "";
  const sectorName = KNOWN_SECTOR_NAMES[sectorCode] ?? rowValue(summary, ["name", "sectorName"]);
  const sectorLabel = KNOWN_SECTOR_NAMES[sectorCode] ? `${sectorCode} · ${KNOWN_SECTOR_NAMES[sectorCode]}` : typeof sectorName === "string" && sectorName.trim() && sectorName !== "업종현재가" ? sectorName : "현재 업종 지수";

  useEffect(() => setTab(initialTab), [payload.screen]);

  return (
    <div className="capture-views-sector-layout">
      <aside className="capture-views-sector-summary" aria-label="업종 요약">
        <header><h3>{sectorLabel}</h3><span>{summary ? "수신값" : UNAVAILABLE}</span></header>
        <div className="capture-views-summary-groups">
          <SummaryTable title="현재가" rows={[
            { label: "업종지수", value: rowValue(summary, ["index", "current", "price"]), precision: 2, tone: rowValue(summary, ["change", "diff"]) },
            { label: "전일대비", value: rowValue(summary, ["change", "diff"]), precision: 2, signed: "change" },
            { label: "등락률", value: rowValue(summary, ["changePct", "rate", "pct"]), precision: 2, signed: "percent" },
          ]} />
          <SummaryTable title="거래" rows={[
            { label: "거래량", value: rowValue(summary, ["volume", "tradingVolume"]) },
            { label: "거래대금", value: rowValue(summary, ["tradingValue", "value"]) },
          ]} />
          <SummaryTable title="시가 / 고가 / 저가" rows={[
            { label: "시가", value: rowValue(summary, ["open", "openPrice"]), precision: 2 },
            { label: "고가", value: rowValue(summary, ["high", "highPrice"]), precision: 2 },
            { label: "저가", value: rowValue(summary, ["low", "lowPrice"]), precision: 2 },
          ]} />
          <SummaryTable title="등락 종목수" rows={[
            { label: "상승", value: rowValue(summary, ["rising", "rise"]) },
            { label: "하락", value: rowValue(summary, ["falling", "fall"]) },
            { label: "보합", value: rowValue(summary, ["flat"]) },
          ]} />
          <SummaryTable title="규모별" rows={[
            { label: "대형주", value: rowValue(summary, ["large", "largeCap"]), precision: 2 },
            { label: "중형주", value: rowValue(summary, ["mid", "midCap"]), precision: 2 },
            { label: "소형주", value: rowValue(summary, ["small", "smallCap"]), precision: 2 },
          ]} />
          <SummaryTable title="52주" rows={[
            { label: "최고", value: rowValue(summary, ["week52High", "high52"]), precision: 2 },
            { label: "최저", value: rowValue(summary, ["week52Low", "low52"]), precision: 2 },
          ]} />
        </div>
        <ScopeNote source={payload.source} status={payload.status} asOf={payload.asOf} note={payload.note} fallback="시가·고가·저가, 규모별, 52주 값은 제공된 필드가 없으면 미수신으로 표시합니다." />
        {summary?.sectorCode && <button type="button" className="classic-button capture-views-sector-pick" onClick={() => onSector?.(summary.sectorCode!)}>이 업종 선택</button>}
      </aside>
      <section className="capture-views-sector-detail" aria-label="업종 상세">
        <div className="classic-tabs capture-views-tabs" role="tablist" aria-label="업종 추이 보기">
          <button type="button" role="tab" disabled={!time} title={time ? undefined : "시간대별 업종 API가 아직 연결되지 않았습니다."} aria-selected={tab === "time"} className={tab === "time" ? "active" : ""} onClick={() => setTab("time")}>시간대별</button>
          <button type="button" role="tab" disabled={!daily} aria-selected={tab === "daily"} className={tab === "daily" ? "active" : ""} onClick={() => setTab("daily")}>일별</button>
          <button type="button" role="tab" disabled={!payload.bars.length} aria-selected={tab === "chart"} className={tab === "chart" ? "active" : ""} onClick={() => setTab("chart")}>차트</button>
          <button type="button" role="tab" disabled={!constituents} aria-selected={tab === "constituents"} className={tab === "constituents" ? "active" : ""} onClick={() => setTab("constituents")}>구성종목</button>
          {extraSections.map((section) => <button key={section.id} type="button" role="tab" aria-selected={tab === `section:${section.id}`} className={tab === `section:${section.id}` ? "active" : ""} onClick={() => setTab(`section:${section.id}`)}>{section.title}</button>)}
        </div>
        <div className="capture-views-tab-content" role="tabpanel">
          {tab === "chart" ? <CaptureChart bars={payload.bars} active={active} ariaLabel="업종 추이 차트" /> : displayedSection ? <SectionGrid section={displayedSection} onPick={onPick} onSector={onSector} /> : <p className="classic-empty">이 보기의 수신 데이터가 없습니다.</p>}
        </div>
      </section>
    </div>
  );
}

function marketRows(payload: Pick<CapturePayload, "rows">) {
  return payload.rows.filter((row) => typeof row.market === "string" && row.market.length > 0);
}

function investorUnit(columns: CaptureColumn[]) {
  const unit = columns.find((column) => column.key === "individual")?.unit;
  return unit === "thousand shares" ? "천주" : unit === "KRW 100m" ? "억원" : unit ?? "미표시";
}

function fieldIsAvailable(field: InvestorField, columns: CaptureColumn[], rows: CaptureRow[]) {
  return columns.some((column) => column.key === field.key) || rows.some((row) => rowValue(row, [field.key]) !== undefined);
}

function signedFlow(value: Cell) {
  return typeof value === "number" ? `${value > 0 ? "+" : ""}${display(value)}` : display(value);
}

function InvestorMarketMatrix({ label, rows, fields }: { label: string; rows: CaptureRow[]; fields: InvestorField[] }) {
  return (
    <div className="capture-views-matrix-scroll">
      <table className="capture-views-investor-matrix" aria-label={label}>
        <thead><tr><th scope="col">시장구분</th>{fields.map((field) => <th key={field.key} scope="col" className={field.tone ? `capture-views-investor-${field.tone}` : undefined}>{field.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}><th scope="row">{display(rowValue(row, ["market", "sector", "name"]), row.id)}</th>{fields.map((field) => { const value = rowValue(row, [field.key]); return <td className={value === undefined || value === null ? "capture-views-unknown" : direction(value)} key={field.key}>{signedFlow(value)}</td>; })}</tr>)}
          {!rows.length && <tr><td colSpan={Math.max(fields.length + 1, 1)} className="capture-views-empty-cell">표시할 시장별 수급 값이 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function InvestorCaptureView({ payload }: { payload: CapturePayload }) {
  const rows = marketRows(payload);
  const detailFields = detailedInvestorFields.filter((field) => fieldIsAvailable(field, payload.columns, rows));
  return (
    <section className="capture-views-investor-layout" aria-label="투자자별 매매동향">
      <header className="capture-views-panel-heading"><div><h3>투자자별 시장 순매수</h3></div><span>단위: {investorUnit(payload.columns)}</span></header>
      <InvestorMarketMatrix label="투자자별 시장 순매수" rows={rows} fields={primaryInvestorFields} />
      {detailFields.length > 0 ? <details className="capture-views-investor-details" open><summary>세부 투자자 항목 ({detailFields.length}개 수신)</summary><InvestorMarketMatrix label="세부 투자자별 시장 순매수" rows={rows} fields={detailFields} /></details> : <p className="capture-views-unavailable">세부 투자자 열은 현재 응답에서 수신되지 않았습니다.</p>}
      <ScopeNote source={payload.source} status={payload.status} asOf={payload.asOf} note={payload.note} fallback="현물(주식) 시장의 기준일 순매수만 표시합니다. 선물·옵션·장중 누적 추이는 포함하지 않습니다." />
    </section>
  );
}

function InvestorByMarketTable({ section }: { section: CaptureSection }) {
  const rows = marketRows(section);
  const fields = [...primaryInvestorFields, ...detailedInvestorFields].filter((field) => fieldIsAvailable(field, section.columns, rows));
  return (
    <div className="capture-views-market-investor-scroll">
      <table className="capture-views-market-investor-table" aria-label="시장별 투자자 순매수">
        <thead><tr><th scope="col">투자자</th>{rows.map((row) => <th key={row.id} scope="col">{display(rowValue(row, ["market", "sector", "name"]), row.id)}</th>)}</tr></thead>
        <tbody>
          {fields.map((field) => <tr key={field.key}><th scope="row" className={field.tone ? `capture-views-investor-${field.tone}` : undefined}>{field.label}</th>{rows.map((row) => { const value = rowValue(row, [field.key]); return <td className={value === undefined || value === null ? "capture-views-unknown" : direction(value)} key={row.id}>{signedFlow(value)}</td>; })}</tr>)}
          {!fields.length && <tr><td colSpan={Math.max(rows.length + 1, 1)} className="capture-views-empty-cell">표시할 투자자 수급 필드가 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function columnFor(section: CaptureSection, key: string) {
  return section.columns.find((column) => column.key === key);
}

function quotePrecision(column: CaptureColumn | undefined) {
  if (typeof column?.precision === "number") return column.precision;
  if (column?.unit === "%" || column?.unit === "percent" || /index|change|대비|등락률/i.test(`${column?.key} ${column?.label}`)) return 2;
  return 0;
}

function quoteText(value: Cell, column: CaptureColumn | undefined, style: "plain" | "change" | "percent" = "plain") {
  const precision = quotePrecision(column);
  if (typeof value !== "number") return display(value);
  const numeric = display(style === "change" ? Math.abs(value) : value, UNAVAILABLE, precision);
  if (style === "change") return `${value > 0 ? "▲ " : value < 0 ? "▼ " : ""}${numeric}`;
  if (style === "percent") return `${value > 0 ? "+" : ""}${numeric}%`;
  return numeric;
}

function compactSource(section: CaptureSection) {
  const formattedAsOf = displayAsOf(section.asOf);
  return [section.source && `출처: ${section.source}`, formattedAsOf && `기준: ${formattedAsOf}`].filter(Boolean).join(" · ");
}

function domesticColumnLabel(column: CaptureColumn) {
  if (column.key === "index" && column.unit === "index") return "지수 (pt)";
  if (column.key === "change" && column.unit === "index") return "전일대비 (pt)";
  if (column.key === "volume" && column.unit === "thousand shares") return "거래량 (천주)";
  if (column.key === "tradingValue" && column.unit === "KRW millions") return "거래대금 (백만원)";
  return column.label;
}

function MarketSourceDetails({ sections }: { sections: CaptureSection[] }) {
  const notes = [...new Set(sections.map((section) => section.note.trim()).filter(Boolean))];
  return notes.length ? <details className="capture-views-market-details"><summary>제공 범위·주의</summary>{notes.map((note) => <p key={note}>{note}</p>)}</details> : null;
}

function DomesticMarketTable({ section, onPick, onSector }: { section: CaptureSection; onPick: (instrument: Instrument) => void; onSector?: (code: string) => void }) {
  return (
    <section className="capture-views-market-panel" aria-label={section.title}>
      <header><h3>{section.title}</h3><span>{compactSource(section)}</span></header>
      <div className="capture-views-domestic-table-wrap"><table className="capture-views-domestic-table" aria-label="국내 지수">
        <thead><tr>{section.columns.map((column) => <th key={column.key} scope="col">{domesticColumnLabel(column)}</th>)}</tr></thead>
        <tbody>{section.rows.map((row) => <tr key={row.id}>{section.columns.map((column) => {
          const value = rowValue(row, [column.key]);
          const kind = column.key === "change" ? "change" : column.key === "changePct" || column.unit === "%" || column.unit === "percent" ? "percent" : "plain";
          const content = column.key === "name" && (row.instrument || row.sectorCode) ? <button type="button" className="classic-row-link" onClick={() => { if (row.instrument) onPick(row.instrument); if (row.sectorCode) onSector?.(row.sectorCode); }}>{quoteText(value, column, kind)}</button> : quoteText(value, column, kind);
          return <td key={column.key} className={`${column.numeric ? "classic-number" : ""} ${kind === "plain" ? "" : direction(value)}`}>{content}</td>;
        })}</tr>)}</tbody>
      </table></div>
      <MarketSourceDetails sections={[section]} />
    </section>
  );
}

function GlobalMarketTable({ sections }: { sections: CaptureSection[] }) {
  const keys = ["name", "last", "change", "changePct", "currency"].filter((key) => sections.some((section) => columnFor(section, key)));
  const label = (key: string) => key === "currency" ? "단위" : sections.map((section) => columnFor(section, key)).find(Boolean)?.label ?? key;
  return (
    <section className="capture-views-global-panel" aria-label="해외 시장">
      <header><h3>해외 지수 · 환율 · 상품</h3></header>
      {sections.length > 0 ? <div className="capture-views-global-table-wrap"><table className="capture-views-global-table" aria-label="해외 지수 환율 상품">
        <thead><tr>{keys.map((key) => <th key={key} scope="col">{label(key)}</th>)}</tr></thead>
        <tbody>{sections.flatMap((section) => [
          <tr className="capture-views-global-group" key={`${section.id}:group`}><th colSpan={Math.max(keys.length, 1)} scope="rowgroup"><span>{section.title}</span><small>{compactSource(section)}</small></th></tr>,
          ...section.rows.map((row) => <tr key={row.id}>{keys.map((key) => {
            const column = columnFor(section, key);
            const value = rowValue(row, [key]);
            const kind = key === "change" ? "change" : key === "changePct" ? "percent" : "plain";
            const content = key === "currency" && section.id === "global-indices" ? "pt" : quoteText(value, column, kind);
            return <td key={key} className={`${column?.numeric ? "classic-number" : ""} ${kind === "plain" ? "" : direction(value)}`}>{content}</td>;
          })}</tr>),
        ])}</tbody>
      </table></div> : <p className="classic-empty">해외 시장 데이터가 수신되지 않았습니다.</p>}
      <MarketSourceDetails sections={sections} />
    </section>
  );
}

export function MarketCaptureView({ payload, onPick, onSector }: Omit<Shared, "active">) {
  const domestic: CaptureSection = { id: "domestic", title: "국내 지수", columns: payload.columns, rows: payload.rows, source: payload.source, status: payload.status, asOf: payload.asOf, note: payload.note };
  const investorSection = payload.sections.find((section) => section.id === "investors");
  const globalSections = payload.sections.filter((section) => section.id !== "investors");
  const breadthRows = payload.rows.filter((row) => /KOSPI|KOSDAQ/i.test(String(rowValue(row, ["name", "market", "id"]) ?? "")));

  return (
    <div className="capture-views-market-layout">
      <section className="capture-views-breadth" aria-label="시장 등락 종목수">
        <header><h3>시장 등락</h3><span>제공 집계만 표시</span></header>
        <div className="capture-views-breadth-grid">{breadthRows.map((row) => <div key={row.id}><strong>{display(rowValue(row, ["name", "market"]), row.id)}</strong>{[{ label: "상승", keys: ["rising", "rise"], tone: "classic-up" }, { label: "하락", keys: ["falling", "fall"], tone: "classic-down" }, { label: "보합", keys: ["flat"], tone: "" }].map(({ label, keys, tone }) => { const value = rowValue(row, keys); return <span key={label} className={value === undefined || value === null ? "capture-views-unknown" : tone}>{label} {display(value)}</span>; })}</div>)}</div>
        {!breadthRows.length && <p className="capture-views-unavailable">국내 시장 등락 종목수는 수신되지 않았습니다.</p>}
      </section>
      <div className="capture-views-market-middle">
        <DomesticMarketTable section={domestic} onPick={onPick} onSector={onSector} />
        <GlobalMarketTable sections={globalSections} />
      </div>
      <section className="capture-views-market-bottom" aria-label="시장 투자자 수급">
        <div className="capture-views-panel-heading"><div><h3>투자자 매매동향</h3><span>행: 투자자 · 열: 시장</span></div>{investorSection && <span>단위: {investorUnit(investorSection.columns)}</span>}</div>
        {investorSection ? <><InvestorByMarketTable section={investorSection} /><ScopeNote source={investorSection.source} status={investorSection.status} asOf={investorSection.asOf} note={investorSection.note} fallback="현물 시장 기준일 순매수입니다." /></> : <p className="classic-empty">투자자 수급 자료가 수신되지 않았습니다.</p>}
        <aside className="capture-views-unavailable-block" aria-label="파생상품과 자금 지표 제공 범위"><strong>파생상품 · 자금 지표</strong><span>현재 조회 데이터에 없음</span><p>선물·옵션, 고객예탁금, 미수금 등은 제공된 값이 없어 대체하거나 추정하지 않습니다.</p></aside>
      </section>
    </div>
  );
}

function articleRowId(instanceId: string, id: string) {
  return `capture-news-${instanceId}-${encodeURIComponent(id).replace(/%/g, "_")}`;
}

export function NewsCaptureView({ payload, provider, onProvider, selectionScope }: { payload: CapturePayload; provider: string; onProvider: (provider: string) => void; selectionScope?: string }) {
  const providers = [
    { id: "all", label: "전체뉴스" }, { id: "mk_stock", label: "매일경제 증권" }, { id: "hankyung_finance", label: "한경 금융" },
    { id: "mk_economy", label: "매일경제" }, { id: "yonhap", label: "연합뉴스" }, { id: "bbc", label: "BBC" }, { id: "npr", label: "NPR" },
    { id: "google", label: "구글뉴스검색" },
  ];
  const visible = payload.news;
  const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const [selectedId, setSelectedId] = useState(visible[0]?.id ?? "");
  const [fontSize, setFontSize] = useState<"small" | "medium" | "large">("medium");

  useEffect(() => {
    setSelectedId(visible[0]?.id ?? "");
  }, [provider, selectionScope]);
  useEffect(() => {
    setSelectedId((current) => visible.some((item) => item.id === current) ? current : (visible[0]?.id ?? ""));
  }, [payload.screen, payload.receivedAt, visible]);

  const selectedIndex = Math.max(0, visible.findIndex((item) => item.id === selectedId));
  const article = visible.find((item) => item.id === selectedId) ?? visible[0];
  const selectAt = (index: number) => {
    const item = visible[index];
    if (!item) return;
    setSelectedId(item.id);
    document.getElementById(articleRowId(instanceId, item.id))?.focus();
  };
  const moveSelection = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    selectAt(event.key === "ArrowDown" ? Math.min(visible.length - 1, selectedIndex + 1) : Math.max(0, selectedIndex - 1));
  };
  const original = article ? safeNewsUrl(article.url) : null;

  return (
    <div className="capture-views-news-layout">
      <nav className="capture-views-news-tree" aria-label="뉴스 제공자" role="tree">
        {providers.map((item) => <button key={item.id} type="button" role="treeitem" aria-selected={provider === item.id} className={provider === item.id ? "active" : ""} onClick={() => { setSelectedId(visible[0]?.id ?? ""); onProvider(item.id); }}>{item.label}</button>)}
      </nav>
      <section className="capture-views-news-main" aria-label="뉴스 목록과 요약">
        <div className="capture-views-news-list" role="list" aria-label="뉴스 목록" onKeyDown={moveSelection}>
          <div className="capture-views-news-list-header" aria-hidden="true"><span>일자</span><span>시간</span><span>제목</span><span>제공처</span><span>연결 종목</span></div>
          {visible.map((item) => { const timestamp = newsDate(item.publishedAt); return <button id={articleRowId(instanceId, item.id)} key={item.id} type="button" role="listitem" className={article?.id === item.id ? "active" : ""} aria-current={article?.id === item.id ? "true" : undefined} onClick={() => setSelectedId(item.id)}><time dateTime={timestamp.dateTime}>{timestamp.date}</time><time dateTime={timestamp.dateTime}>{timestamp.time}</time><b>{item.title}</b><span>{item.provider}</span><span>{item.symbol?.trim() || "—"}</span></button>; })}
          {!visible.length && <p className="classic-empty">표시할 뉴스가 없습니다.</p>}
        </div>
        <div className="capture-views-reader-bar" aria-label="선택한 뉴스 도구"><strong>{article?.title ?? "뉴스를 선택하세요."}</strong><div role="group" aria-label="요약 글자 크기"><button type="button" aria-label="글자 작게" aria-pressed={fontSize === "small"} onClick={() => setFontSize("small")}>가−</button><button type="button" aria-label="글자 보통" aria-pressed={fontSize === "medium"} onClick={() => setFontSize("medium")}>가</button><button type="button" aria-label="글자 크게" aria-pressed={fontSize === "large"} onClick={() => setFontSize("large")}>가+</button></div></div>
        <article className="capture-views-news-reader" data-font-size={fontSize} aria-label="뉴스 요약">
          {article ? <><h3>{article.title}</h3><p className="capture-views-news-meta">{article.provider} · {newsDate(article.publishedAt).combined} · 연결 종목: {article.symbol?.trim() || "없음"}</p><p>{article.summary || "제공된 요약이 없습니다."}</p>{original ? <a href={original} target="_blank" rel="noopener noreferrer">원문 링크 열기 ↗</a> : <p className="capture-views-unavailable">안전한 원문 링크가 제공되지 않았습니다.</p>}</> : <p className="classic-empty">뉴스를 선택하세요.</p>}
          <ScopeNote source={payload.source} status={payload.status} asOf={payload.asOf} note={newsScopeNote(payload.note)} />
        </article>
      </section>
    </div>
  );
}
