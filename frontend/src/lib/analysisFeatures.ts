import { ApiShapeError, parseInstrument } from "./api";
import type { Instrument, Market } from "./types";

export type AnalysisParameterType = "select" | "date" | "text" | "number";
export type AnalysisSource = "kiwoom" | "fixture" | "sec" | "dart";
export type AnalysisStatus = "snapshot" | "missing" | "error" | "fixture" | "setup-required";
export type AnalysisScalar = string | number | boolean | null;
export type AnalysisMetadata = AnalysisScalar | AnalysisMetadata[] | { [key: string]: AnalysisMetadata };

export type AnalysisParameterOption = { value: string; label: string };
export type AnalysisParameter = {
  key: string;
  label: string;
  type: AnalysisParameterType;
  default: string;
  options?: AnalysisParameterOption[];
  maxLength?: number;
};

export type AnalysisFeature = {
  id: string;
  title: string;
  market: Market;
  description: string;
  parameters: AnalysisParameter[];
  requiredParameters: string[];
};

export type AnalysisColumn = { key: string; label: string; numeric: boolean; unit?: string };
export type AnalysisRow = { id: string; instrument?: Instrument; [key: string]: unknown };
export type AnalysisPayload = {
  featureId: string;
  title: string;
  market: Market;
  source: AnalysisSource;
  status: AnalysisStatus;
  receivedAt: string | null;
  asOf: string | null;
  note: string;
  complete: boolean;
  columns: AnalysisColumn[];
  rows: AnalysisRow[];
  scope?: Record<string, AnalysisMetadata>;
  parameters?: Record<string, AnalysisMetadata>;
};

type JsonObject = Record<string, unknown>;

const parameterTypes = ["select", "date", "text", "number"] as const;
const markets = ["KR", "US"] as const;
const sources = ["kiwoom", "fixture", "sec", "dart"] as const;
const statuses = ["snapshot", "missing", "error", "fixture", "setup-required"] as const;
const safeKey = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiShapeError(`${label} 응답 형식이 올바르지 않습니다.`);
  return value as JsonObject;
}

function requiredString(value: unknown, label: string, maxLength = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApiShapeError(`${label} 값이 올바르지 않습니다.`);
  }
  return value;
}

function optionValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApiShapeError(`${label} 값이 올바르지 않습니다.`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label);
}

function member<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new ApiShapeError(`${label} 값이 올바르지 않습니다.`);
  return value as T[number];
}

function key(value: unknown, label: string) {
  if (typeof value !== "string" || !safeKey.test(value)) throw new ApiShapeError(`${label} 값이 올바르지 않습니다.`);
  return value;
}

function parameterValue(parameter: AnalysisParameter, raw: unknown): string {
  if (typeof raw !== "string" || raw.length > (parameter.maxLength ?? 120) || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ApiShapeError(`${parameter.label} 입력값이 올바르지 않습니다.`);
  }
  if (parameter.type === "select" && !parameter.options?.some((option) => option.value === raw)) {
    throw new ApiShapeError(`${parameter.label} 선택값이 올바르지 않습니다.`);
  }
  if (parameter.type === "date" && raw && !datePattern.test(raw)) throw new ApiShapeError(`${parameter.label} 날짜 형식이 올바르지 않습니다.`);
  if (parameter.type === "number" && raw && !numberPattern.test(raw)) throw new ApiShapeError(`${parameter.label} 숫자 형식이 올바르지 않습니다.`);
  return raw;
}

function seoulToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new ApiShapeError("서울 기준일을 계산할 수 없습니다.");
  return `${year}-${month}-${day}`;
}

function parseParameter(value: unknown, index: number): AnalysisParameter {
  const row = object(value, `parameters[${index}]`);
  const type = member(row.type, parameterTypes, `parameters[${index}].type`);
  const defaultValue = row.default;
  if ((typeof defaultValue !== "string" && typeof defaultValue !== "number") || (typeof defaultValue === "number" && !Number.isFinite(defaultValue))) {
    throw new ApiShapeError(`parameters[${index}].default 값이 올바르지 않습니다.`);
  }
  const parameter: AnalysisParameter = {
    key: key(row.key, `parameters[${index}].key`),
    label: requiredString(row.label, `parameters[${index}].label`, 120),
    type,
    default: type === "date" && defaultValue === "today" ? seoulToday() : String(defaultValue),
  };
  if (row.maxLength !== undefined) {
    if (typeof row.maxLength !== "number" || !Number.isInteger(row.maxLength) || row.maxLength < 1 || row.maxLength > 2048) throw new ApiShapeError("조회 조건 길이가 올바르지 않습니다.");
    parameter.maxLength = row.maxLength;
  }
  if (type === "select") {
    if (!Array.isArray(row.options) || row.options.length === 0) throw new ApiShapeError(`parameters[${index}].options 값이 올바르지 않습니다.`);
    const values = new Set<string>();
    parameter.options = row.options.map((option, optionIndex) => {
      const parsed = object(option, `parameters[${index}].options[${optionIndex}]`);
      const parsedOption = {
        value: optionValue(parsed.value, `parameters[${index}].options[${optionIndex}].value`),
        label: requiredString(parsed.label, `parameters[${index}].options[${optionIndex}].label`, 120),
      };
      if (values.has(parsedOption.value)) throw new ApiShapeError(`parameters[${index}] 옵션이 중복됩니다.`);
      values.add(parsedOption.value);
      return parsedOption;
    });
  } else if (row.options !== undefined) {
    throw new ApiShapeError(`parameters[${index}].options 값이 올바르지 않습니다.`);
  }
  parameter.default = parameterValue(parameter, parameter.default);
  return parameter;
}

export function parseAnalysisFeatures(value: unknown): AnalysisFeature[] {
  const response = object(value, "분석 기능");
  if (!Array.isArray(response.features)) throw new ApiShapeError("분석 기능 목록 형식이 올바르지 않습니다.");
  const ids = new Set<string>();
  return response.features.map((entry, index) => {
    const row = object(entry, `features[${index}]`);
    if (!Array.isArray(row.parameters)) throw new ApiShapeError(`features[${index}].parameters 값이 올바르지 않습니다.`);
    const feature: AnalysisFeature = {
      id: key(row.id, `features[${index}].id`),
      title: requiredString(row.title, `features[${index}].title`, 160),
      market: member(row.market, markets, `features[${index}].market`),
      description: requiredString(row.description, `features[${index}].description`, 1000),
      parameters: row.parameters.map(parseParameter),
      requiredParameters: row.requiredParameters === undefined
        ? []
        : Array.isArray(row.requiredParameters)
          ? row.requiredParameters.map((parameterKey, requiredIndex) => key(parameterKey, `features[${index}].requiredParameters[${requiredIndex}]`))
          : (() => { throw new ApiShapeError(`features[${index}].requiredParameters 값이 올바르지 않습니다.`); })(),
    };
    if (ids.has(feature.id)) throw new ApiShapeError("분석 기능 ID가 중복됩니다.");
    ids.add(feature.id);
    const parameterKeys = new Set<string>();
    for (const parameter of feature.parameters) {
      if (parameterKeys.has(parameter.key)) throw new ApiShapeError(`${feature.title}의 조건 키가 중복됩니다.`);
      parameterKeys.add(parameter.key);
    }
    const requiredKeys = new Set<string>();
    for (const parameterKey of feature.requiredParameters) {
      if (!parameterKeys.has(parameterKey) || requiredKeys.has(parameterKey)) {
        throw new ApiShapeError(`${feature.title}의 필수 조건 키가 올바르지 않습니다.`);
      }
      requiredKeys.add(parameterKey);
    }
    return feature;
  });
}

export function defaultAnalysisParameters(feature: AnalysisFeature): Record<string, string> {
  return Object.fromEntries(feature.parameters.map((parameter) => [parameter.key, parameter.default]));
}

/** Retains only server-declared fields and validates their form values before a request. */
export function normalizeAnalysisParameters(feature: AnalysisFeature, values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(feature.parameters.map((parameter) => [parameter.key, parameterValue(parameter, values[parameter.key] ?? parameter.default)]));
}

function metadataValue(value: unknown, label: string, depth: number): AnalysisMetadata {
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
    if (typeof value === "string" && (value.length > 500 || /[\u0000-\u001f\u007f]/.test(value))) throw new ApiShapeError(`${label} 값이 올바르지 않습니다.`);
    return value;
  }
  if (depth >= 3) throw new ApiShapeError(`${label} 값이 너무 깊습니다.`);
  if (Array.isArray(value)) {
    if (value.length > 100) throw new ApiShapeError(`${label} 목록이 너무 깁니다.`);
    return value.map((entry, index) => metadataValue(entry, `${label}[${index}]`, depth + 1));
  }
  return metadataRecord(value, label, depth + 1);
}

function metadataRecord(value: unknown, label: string, depth = 0): Record<string, AnalysisMetadata> {
  const row = object(value, label);
  const entries = Object.entries(row);
  if (entries.length > 100) throw new ApiShapeError(`${label} 항목이 너무 많습니다.`);
  const parsed: Record<string, AnalysisMetadata> = {};
  for (const [entryKey, entryValue] of entries) {
    key(entryKey, `${label}.${entryKey}`);
    parsed[entryKey] = metadataValue(entryValue, `${label}.${entryKey}`, depth);
  }
  return parsed;
}

export function parseAnalysisPayload(value: unknown, expected: Pick<Instrument, "market" | "environment"> & { featureId: string }): AnalysisPayload {
  const response = object(value, "분석 결과");
  const columnsRaw = response.columns;
  const rowsRaw = response.rows;
  if (!Array.isArray(columnsRaw) || !Array.isArray(rowsRaw)) throw new ApiShapeError("분석 표 형식이 올바르지 않습니다.");
  const featureId = key(response.featureId, "featureId");
  if (featureId !== expected.featureId) throw new ApiShapeError("요청한 분석 기능과 응답이 일치하지 않습니다.");
  const market = member(response.market, markets, "market");
  if (market !== expected.market) throw new ApiShapeError("요청한 시장과 응답이 일치하지 않습니다.");
  const source = member(response.source, sources, "source");
  if (source === "fixture" && expected.environment !== "fixture") throw new ApiShapeError("실거래 환경에 테스트 분석 자료를 표시할 수 없습니다.");
  const columnKeys = new Set<string>();
  const columns = columnsRaw.map((entry, index) => {
    const row = object(entry, `columns[${index}]`);
    const parsed: AnalysisColumn = {
      key: key(row.key, `columns[${index}].key`),
      label: requiredString(row.label, `columns[${index}].label`, 120),
      numeric: typeof row.numeric === "boolean" ? row.numeric : (() => { throw new ApiShapeError(`columns[${index}].numeric 값이 올바르지 않습니다.`); })(),
      ...(row.unit === undefined ? {} : { unit: requiredString(row.unit, `columns[${index}].unit`, 40) }),
    };
    if (columnKeys.has(parsed.key)) throw new ApiShapeError("분석 열 키가 중복됩니다.");
    columnKeys.add(parsed.key);
    return parsed;
  });
  const rowIds = new Set<string>();
  const rows = rowsRaw.map((entry, index) => {
    const row = object(entry, `rows[${index}]`);
    const parsed: AnalysisRow = { id: requiredString(row.id, `rows[${index}].id`, 160) };
    if (rowIds.has(parsed.id)) throw new ApiShapeError("분석 행 ID가 중복됩니다.");
    rowIds.add(parsed.id);
    for (const column of columns) {
      const cell = row[column.key];
      if (cell === undefined || (cell !== null && typeof cell !== "string" && typeof cell !== "boolean" && (typeof cell !== "number" || !Number.isFinite(cell)))) {
        throw new ApiShapeError(`rows[${index}].${column.key} 값이 올바르지 않습니다.`);
      }
      if (column.numeric && cell !== null && typeof cell !== "number") throw new ApiShapeError(`rows[${index}].${column.key} 숫자값이 올바르지 않습니다.`);
      parsed[column.key] = cell;
    }
    if (row.instrument !== undefined) {
      const instrument = parseInstrument(row.instrument);
      if (instrument.market !== market || instrument.environment !== expected.environment) {
        throw new ApiShapeError("분석 행 종목 식별자가 현재 분석 범위와 일치하지 않습니다.");
      }
      parsed.instrument = instrument;
    }
    return parsed;
  });
  return {
    featureId,
    title: requiredString(response.title, "title", 160),
    market,
    source,
    status: member(response.status, statuses, "status"),
    receivedAt: nullableString(response.receivedAt, "receivedAt"),
    asOf: nullableString(response.asOf, "asOf"),
    note: typeof response.note === "string" && response.note.length <= 1000 ? response.note : "",
    complete: typeof response.complete === "boolean" ? response.complete : (() => { throw new ApiShapeError("complete 값이 올바르지 않습니다."); })(),
    columns,
    rows,
    ...(response.scope === undefined ? {} : { scope: metadataRecord(response.scope, "scope") }),
    ...(response.parameters === undefined ? {} : { parameters: metadataRecord(response.parameters, "parameters") }),
  };
}

function metadataText(value: AnalysisMetadata): string {
  if (value === null) return "—";
  if (Array.isArray(value)) return `[${value.map(metadataText).join(", ")}]`;
  if (typeof value === "object") return `{${Object.entries(value).map(([entryKey, entryValue]) => `${entryKey}:${metadataText(entryValue)}`).join(", ")}}`;
  return String(value);
}

export function analysisScopeText(values: Record<string, AnalysisMetadata> | undefined): string {
  if (!values || Object.keys(values).length === 0) return "없음";
  return Object.entries(values).map(([entryKey, value]) => `${entryKey}=${metadataText(value)}`).join(" · ");
}

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toAnalysisCsv(payload: AnalysisPayload, rows = payload.rows): string {
  const metadata = [
    ["featureId", payload.featureId],
    ["source", payload.source],
    ["receivedAt", payload.receivedAt ?? ""],
    ["asOf", payload.asOf ?? ""],
    ["scope", analysisScopeText(payload.scope)],
    ["parameters", analysisScopeText(payload.parameters)],
  ];
  const header = payload.columns.map((column) => column.unit ? `${column.label} (${column.unit})` : column.label);
  const body = rows.map((row) => payload.columns.map((column) => row[column.key]));
  return [...metadata.map((entry) => entry.map(csvCell).join(",")), "", header.map(csvCell).join(","), ...body.map((entry) => entry.map(csvCell).join(","))].join("\r\n");
}
