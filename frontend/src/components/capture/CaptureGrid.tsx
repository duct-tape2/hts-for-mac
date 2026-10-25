"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { CaptureColumn, CaptureRow } from "@/lib/capture";
import type { ColumnPresentation, ScreenPresentation } from "@/lib/screenPresentation";
import "../captureTables.css";

export type GridSort = { key: string; direction: "asc" | "desc" };

type CaptureGridProps = {
  label: string;
  columns: CaptureColumn[];
  rows: CaptureRow[];
  selectedId?: string;
  sort?: GridSort;
  onSort?: (next: GridSort) => void;
  onSelectRow?: (row: CaptureRow) => void;
  onPick?: (row: CaptureRow) => void;
  onSector?: (code: string) => void;
  presentation?: ScreenPresentation;
  columnWidths?: Record<string, number>;
  onColumnWidthsChange?: (next: Record<string, number>) => void;
};

const UNIT_LABELS: Record<string, string> = {
  KRW: "원", USD: "달러", shares: "주", "KRW millions": "백만원", "KRW 100m": "억원", "thousand shares": "천주", index: "지수", percent: "%", "%": "%",
};

function isInvestorFlowField(column: CaptureColumn) {
  return /^(individual|foreign|institutional|securities|insurance|investmentTrust|bank|pension|fund|privateFund|national|nativeTrmtForeign|otherCorporation)$/i.test(column.key)
    || /(개인|외국인|기관계|금융투자|보험|투신|은행|종금|연기금|사모|국가|기타법인|내국인대우|순매수)/i.test(column.label);
}

function columnPresentation(column: CaptureColumn, presentation?: ScreenPresentation): ColumnPresentation {
  const known = presentation?.columns[column.key];
  if (known) return { ...known, precision: column.precision ?? known.precision };
  const field = `${column.key} ${column.label}`;
  const precision = column.precision ?? (column.unit === "index" ? 2 : undefined);
  const format = column.unit === "USD" ? "usd"
    : column.unit === "%" || column.unit === "percent" ? "percent"
      : column.unit === "index" ? "price"
        : /rankChange|순위등락/i.test(field) ? "rankChange"
          : isInvestorFlowField(column) ? "netFlow"
          : /change|diff|대비|등락/i.test(field) ? "change"
            : column.numeric ? "integer" : "text";
  return { width: column.numeric ? 96 : 140, format, precision };
}

function formatInteger(value: number, precision = 0) {
  return value.toLocaleString("ko-KR", { minimumFractionDigits: precision, maximumFractionDigits: precision });
}

function officialRankDirection(sign: unknown) {
  const source = typeof sign === "string" ? sign.trim().toLowerCase() : "";
  // Kiwoom's documented ka00198 contract: rank_chg_sign is `+` for a rank
  // rise, `-` for a fall, and empty for no change. The official example uses
  // `N` with rank_chg 0, so that pair is deliberately neutral as well.
  // Source: Kiwoom-Securities/Kiwoom-REST-API kiwoom_api_spec.json (ka00198).
  if (source === "+") return "↑";
  if (source === "-") return "↓";
  return "";
}

function formatCaptureDatetime(value: string) {
  const compact = value.replace(/[^0-9]/g, "");
  if (!/^\d{14}$/.test(compact)) return value;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)} ${compact.slice(8, 10)}:${compact.slice(10, 12)}:${compact.slice(12, 14)}`;
}

function cellText(column: CaptureColumn, row: CaptureRow, value: string | number | null | undefined, presentation?: ScreenPresentation) {
  if (value === null || value === undefined || value === "") return "—";
  const next = columnPresentation(column, presentation);
  const format = column.unit === "USD" ? "usd" : next.format ?? "text";
  if (format === "datetime" && typeof value === "string") return formatCaptureDatetime(value);
  if (typeof value !== "number") return value;
  if (format === "percent") return `${formatInteger(value, next.precision ?? 2)}%`;
  if (format === "ratio") return `${formatInteger(value, next.precision ?? 2)}%`;
  if (format === "strength") return formatInteger(value, next.precision ?? 2);
  if (format === "usd") return value.toLocaleString("en-US", { minimumFractionDigits: next.precision ?? 2, maximumFractionDigits: next.precision ?? 2 });
  if (format === "netFlow") return value > 0 ? `+${formatInteger(value, next.precision ?? 0)}` : value < 0 ? `-${formatInteger(Math.abs(value), next.precision ?? 0)}` : formatInteger(value, next.precision ?? 0);
  if (format === "change") {
    const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "";
    return `${arrow ? `${arrow} ` : ""}${formatInteger(Math.abs(value), next.precision ?? 0)}`;
  }
  if (format === "rankChange") {
    const arrow = officialRankDirection(row.rankChangeSign);
    const rawSign = typeof row.rankChangeSign === "string" ? row.rankChangeSign.trim() : "";
    const neutral = value === 0 && (!rawSign || rawSign.toUpperCase() === "N");
    const unclassified = rawSign && !arrow && !neutral ? ` (${rawSign})` : "";
    return neutral ? "—" : `${arrow ? `${arrow} ` : ""}${formatInteger(Math.abs(value), next.precision ?? 0)}${unclassified}`;
  }
  if (format === "price" || format === "integer") return formatInteger(value, next.precision ?? 0);
  return value.toLocaleString("ko-KR", { maximumFractionDigits: next.precision ?? 4 });
}

function tone(value: unknown) {
  return typeof value === "number" ? value > 0 ? "classic-up" : value < 0 ? "classic-down" : "" : "";
}

function valueTone(column: CaptureColumn, row: CaptureRow, value: string | number | null | undefined, presentation?: ScreenPresentation) {
  if (value === null || value === undefined || value === "") return "";
  const format = columnPresentation(column, presentation).format;
  if (format === "rankChange") {
    const direction = officialRankDirection(row.rankChangeSign);
    return direction === "↑" ? "classic-up" : direction === "↓" ? "classic-down" : "";
  }
  if (format === "ratio") return "";
  if (format === "strength") {
    return typeof value === "number" ? value > 100 ? "classic-up" : value < 100 ? "classic-down" : "" : "";
  }
  if (format === "netFlow" || format === "change" || format === "percent") return tone(value);
  const field = `${column.key} ${column.label}`;
  if (isInvestorFlowField(column) || /(change|diff|pct|return|net|대비|등락|순매수)/i.test(field)) return tone(value);
  if (/^(price|sellPrice|buyPrice)$/.test(column.key)) return tone(row.change ?? row.changePct);
  return "";
}

function unitText(unit: string | undefined) {
  return unit ? UNIT_LABELS[unit] ?? unit : "";
}

function columnName(column: CaptureColumn, displayLabel: string) {
  const unit = unitText(column.unit);
  return unit && !displayLabel.includes(`(${unit})`) ? `${displayLabel} (${unit})` : displayLabel;
}

function stableSort(rows: CaptureRow[], sort: GridSort | undefined) {
  if (!sort) return rows;
  const direction = sort.direction === "asc" ? 1 : -1;
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const a = left.row[sort.key] as string | number | null | undefined;
    const b = right.row[sort.key] as string | number | null | undefined;
    if (a === null || a === undefined) return b === null || b === undefined ? left.index - right.index : 1;
    if (b === null || b === undefined) return -1;
    if (typeof a === "number" && typeof b === "number") return (a - b) * direction || left.index - right.index;
    return String(a).localeCompare(String(b), "ko") * direction || left.index - right.index;
  }).map(({ row }) => row);
}

function rowDomId(prefix: string, row: CaptureRow) {
  return `classic-row-${prefix}-${encodeURIComponent(row.id).replace(/%/g, "_")}`;
}

function resolvedWidth(column: CaptureColumn, presentation: ScreenPresentation | undefined, widths: Record<string, number> | undefined) {
  const persisted = widths?.[column.key];
  return typeof persisted === "number" && Number.isFinite(persisted) ? Math.min(420, Math.max(56, Math.round(persisted))) : columnPresentation(column, presentation).width;
}

export function CaptureGrid({ label, columns, rows, selectedId, sort, onSort, onSelectRow, onPick, onSector, presentation, columnWidths, onColumnWidthsChange }: CaptureGridProps) {
  const [localSort, setLocalSort] = useState<GridSort>();
  const [localSelectedId, setLocalSelectedId] = useState<string>();
  const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const gridRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const effectiveSort = onSort ? sort : localSort ?? sort;
  const visibleRows = useMemo(() => stableSort(rows, effectiveSort), [rows, effectiveSort]);
  const displayColumns = useMemo(() => columns
    .map((column, index) => ({ column, index, spec: columnPresentation(column, presentation) }))
    .filter(({ spec }) => spec.visible !== false)
    .sort((left, right) => (left.spec.order ?? Number.MAX_SAFE_INTEGER) - (right.spec.order ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    .map(({ column }) => column), [columns, presentation]);
  const widths = useMemo(() => Object.fromEntries(displayColumns.map((column) => [column.key, resolvedWidth(column, presentation, columnWidths)])), [columnWidths, displayColumns, presentation]);
  const pinnedLefts = useMemo(() => {
    let left = 0;
    const result: Record<string, number> = {};
    for (const column of displayColumns) {
      if (!columnPresentation(column, presentation).pinned) continue;
      result[column.key] = left;
      left += widths[column.key] ?? 0;
    }
    return result;
  }, [displayColumns, presentation, widths]);
  const units = useMemo(() => [...new Set(displayColumns.map((column) => unitText(column.unit)).filter(Boolean))], [displayColumns]);
  const tableWidth = useMemo(() => displayColumns.reduce((total, column) => total + (widths[column.key] ?? 0), 0), [displayColumns, widths]);
  const currentSelectedId = selectedId ?? localSelectedId;
  const selectable = visibleRows.filter((row) => row.instrument || row.sectorCode);
  const selectedIndex = selectable.findIndex((row) => row.id === currentSelectedId);

  const select = (row: CaptureRow) => {
    if (selectedId === undefined) setLocalSelectedId(row.id);
    onSelectRow?.(row);
  };
  const scrollTo = (row: CaptureRow) => rowRefs.current.get(row.id)?.scrollIntoView?.({ block: "nearest" });
  const activate = (row: CaptureRow) => {
    select(row);
    gridRef.current?.focus({ preventScroll: true });
    if (row.instrument) onPick?.(row);
    if (row.sectorCode) onSector?.(row.sectorCode);
  };
  const selectAt = (index: number) => {
    const row = selectable[index];
    if (!row) return;
    select(row);
    scrollTo(row);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && event.target instanceof HTMLElement && event.target.closest("button,input,select,a")) return;
    if (!selectable.length) return;
    const nextIndex = event.key === "ArrowDown" ? Math.min(selectable.length - 1, selectedIndex < 0 ? 0 : selectedIndex + 1)
      : event.key === "ArrowUp" ? Math.max(0, selectedIndex - 1) : -1;
    if (nextIndex >= 0) {
      event.preventDefault();
      selectAt(nextIndex);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const row = selectable[selectedIndex < 0 ? 0 : selectedIndex];
      if (row) activate(row);
    }
  };
  const changeSort = (column: CaptureColumn) => {
    const active = effectiveSort?.key === column.key;
    const next: GridSort = { key: column.key, direction: active && effectiveSort?.direction === "desc" ? "asc" : "desc" };
    if (onSort) onSort(next);
    else setLocalSort(next);
  };
  const resize = (event: PointerEvent<HTMLButtonElement>, column: CaptureColumn) => {
    if (!onColumnWidthsChange) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widths[column.key] ?? 96;
    const move = (pointer: globalThis.PointerEvent) => {
      const nextWidth = Math.min(420, Math.max(56, Math.round(startWidth + pointer.clientX - startX)));
      onColumnWidthsChange({ ...(columnWidths ?? {}), [column.key]: nextWidth });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };

  return (
    <div className="capture-grid-wrap">
      {units.length > 0 && <p className="capture-grid-units">단위: {units.join(" · ")}</p>}
      <div ref={gridRef} className="classic-grid-scroll capture-grid-scroll" role="grid" aria-label={label} tabIndex={0} aria-activedescendant={currentSelectedId ? rowDomId(instanceId, { id: currentSelectedId }) : undefined} onKeyDown={onKeyDown}>
        <table className="classic-grid capture-grid" style={{ width: `${tableWidth}px`, minWidth: `${tableWidth}px` }}>
          <colgroup>{displayColumns.map((column) => <col key={column.key} style={{ width: `${widths[column.key]}px` }} />)}</colgroup>
          <thead><tr>{displayColumns.map((column) => {
            const active = effectiveSort?.key === column.key;
            const columnSpec = columnPresentation(column, presentation);
            const displayLabel = columnSpec.label ?? column.label;
            const pinned = columnSpec.pinned;
            return <th key={column.key} className={pinned ? "capture-grid-pinned" : undefined} style={pinned ? { left: `${pinnedLefts[column.key] ?? 0}px` } : undefined} aria-sort={active ? (effectiveSort?.direction === "asc" ? "ascending" : "descending") : "none"}>
              <button type="button" className="classic-column-button" onClick={() => changeSort(column)} aria-label={columnName(column, displayLabel)}>
                {displayLabel}{active ? (effectiveSort?.direction === "asc" ? " ▲" : " ▼") : ""}
              </button>
              {onColumnWidthsChange && <button type="button" className="capture-column-resize" aria-label={`${displayLabel} 너비 조절`} onPointerDown={(event) => resize(event, column)} />}
            </th>;
          })}</tr></thead>
          <tbody>
            {visibleRows.map((row) => <tr id={rowDomId(instanceId, row)} key={row.id} ref={(element) => { if (element) rowRefs.current.set(row.id, element); else rowRefs.current.delete(row.id); }} tabIndex={-1} aria-selected={currentSelectedId === row.id || undefined} className={currentSelectedId === row.id ? "classic-selected" : undefined} onClick={() => activate(row)} onDoubleClick={() => activate(row)}>
              {displayColumns.map((column) => {
                const value = row[column.key] as string | number | null | undefined;
                const columnSpec = columnPresentation(column, presentation);
                const pinned = columnSpec.pinned;
                const firstName = row.instrument && (column.key === "name" || /종목명|업종명|name/i.test(column.label));
                const text = cellText(column, row, value, presentation);
                return <td key={column.key} className={`${column.numeric ? "classic-number" : ""} ${valueTone(column, row, value, presentation)} ${pinned ? "capture-grid-pinned" : ""}`} style={pinned ? { left: `${pinnedLefts[column.key] ?? 0}px` } : undefined}>
                  {firstName ? <button type="button" className="classic-row-link" title={text === "—" ? undefined : text} onClick={(event) => { event.stopPropagation(); activate(row); }}>{text}</button> : <span title={text === "—" ? undefined : text}>{text}</span>}
                </td>;
              })}
            </tr>)}
            {!visibleRows.length && <tr><td className="classic-empty-cell" colSpan={Math.max(displayColumns.length, 1)}>표시할 항목이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
