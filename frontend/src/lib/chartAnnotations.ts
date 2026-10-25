/**
 * Browser-local chart tools. These records deliberately contain only drawing
 * coordinates and indicator display settings: no quotes, credentials, or
 * upstream market payloads are persisted here.
 */

export const CHART_TOOLS_STORAGE_KEY = "kiwoom-hts-chart-tools-v1";
export const CHART_TOOLS_SCHEMA_VERSION = 1;
const MAX_SCOPES = 48;
const MAX_DRAWINGS_PER_SCOPE = 120;
const MAX_TEMPLATES_PER_SCOPE = 16;
const MAX_UNDO_ENTRIES = 24;
const MAX_TEXT_LENGTH = 120;

export type ChartAnnotationKind = "horizontal" | "vertical" | "trend" | "rectangle" | "fibonacci" | "measurement" | "text";
export type ChartAnnotationPoint = { time: string; price: number };
export type ChartAnnotation = {
  id: string;
  kind: ChartAnnotationKind;
  start: ChartAnnotationPoint;
  end?: ChartAnnotationPoint;
  text?: string;
};
export type ChartIndicatorSettings = {
  displayMode: "candles" | "line";
  movingAverages: Record<"5" | "20" | "60" | "120" | "240", boolean>;
  showRsi: boolean;
  showMacd: boolean;
  showBollingerBands: boolean;
};
export type ChartIndicatorTemplate = { id: string; name: string; settings: ChartIndicatorSettings };
export type ChartToolScope = { drawings: ChartAnnotation[]; templates: ChartIndicatorTemplate[] };
export type ChartToolStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type ChartAnnotationScope = {
  market: string;
  stkCd: string;
  listingVenue: string;
  quoteVenue: string;
  currency: string;
  environment: string;
  interval: string;
};

type StoredScope = ChartToolScope & { updatedAt: number };
type StoredDocument = { version: number; scopes: Record<string, StoredScope> };

const EMPTY_SCOPE: ChartToolScope = { drawings: [], templates: [] };
const kinds = new Set<ChartAnnotationKind>(["horizontal", "vertical", "trend", "rectangle", "fibonacci", "measurement", "text"]);

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function text(value: unknown, limit = MAX_TEXT_LENGTH) {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001F\u007F]/.test(value) ? value : null;
}

function point(value: unknown): ChartAnnotationPoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const time = text(row.time, 64);
  return time && finite(row.price) ? { time, price: row.price } : null;
}

function annotation(value: unknown): ChartAnnotation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 80);
  const kind = typeof row.kind === "string" && kinds.has(row.kind as ChartAnnotationKind) ? row.kind as ChartAnnotationKind : null;
  const start = point(row.start);
  const end = row.end === undefined ? undefined : point(row.end) ?? undefined;
  const label = row.text === undefined ? undefined : text(row.text);
  if (!id || !kind || !start) return null;
  if (["trend", "rectangle", "fibonacci", "measurement"].includes(kind) && !end) return null;
  return { id, kind, start, ...(end ? { end } : {}), ...(label ? { text: label } : {}) };
}

function settings(value: unknown): ChartIndicatorSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.displayMode !== "candles" && row.displayMode !== "line") return null;
  if (!row.movingAverages || typeof row.movingAverages !== "object" || Array.isArray(row.movingAverages)) return null;
  const ma = row.movingAverages as Record<string, unknown>;
  const periods = ["5", "20", "60", "120", "240"] as const;
  if (periods.some((period) => typeof ma[period] !== "boolean")) return null;
  if (typeof row.showRsi !== "boolean" || typeof row.showMacd !== "boolean" || typeof row.showBollingerBands !== "boolean") return null;
  return {
    displayMode: row.displayMode,
    movingAverages: { "5": ma["5"] as boolean, "20": ma["20"] as boolean, "60": ma["60"] as boolean, "120": ma["120"] as boolean, "240": ma["240"] as boolean },
    showRsi: row.showRsi,
    showMacd: row.showMacd,
    showBollingerBands: row.showBollingerBands,
  };
}

function template(value: unknown): ChartIndicatorTemplate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 80);
  const name = text(row.name, 40);
  const nextSettings = settings(row.settings);
  return id && name && nextSettings ? { id, name, settings: nextSettings } : null;
}

export function chartAnnotationScopeKey(scope: ChartAnnotationScope) {
  return [scope.environment, scope.market, scope.stkCd, scope.listingVenue, scope.quoteVenue, scope.currency, scope.interval].map((part) => String(part).trim()).join("|");
}

export function sanitizeChartToolScope(value: unknown): ChartToolScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_SCOPE };
  const row = value as Record<string, unknown>;
  const seenDrawings = new Set<string>();
  const drawings: ChartAnnotation[] = [];
  for (const value of Array.isArray(row.drawings) ? row.drawings : []) {
    const item = annotation(value);
    if (!item || seenDrawings.has(item.id)) continue;
    seenDrawings.add(item.id);
    drawings.push(item);
  }
  drawings.splice(0, Math.max(0, drawings.length - MAX_DRAWINGS_PER_SCOPE));
  const seenTemplates = new Set<string>();
  const templates: ChartIndicatorTemplate[] = [];
  for (const value of Array.isArray(row.templates) ? row.templates : []) {
    const item = template(value);
    if (!item || seenTemplates.has(item.id)) continue;
    seenTemplates.add(item.id);
    templates.push(item);
  }
  templates.splice(0, Math.max(0, templates.length - MAX_TEMPLATES_PER_SCOPE));
  return { drawings, templates };
}

function readDocument(storage: ChartToolStorage | null | undefined): StoredDocument {
  if (!storage) return { version: CHART_TOOLS_SCHEMA_VERSION, scopes: {} };
  try {
    const raw = storage.getItem(CHART_TOOLS_STORAGE_KEY);
    if (!raw) return { version: CHART_TOOLS_SCHEMA_VERSION, scopes: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version: CHART_TOOLS_SCHEMA_VERSION, scopes: {} };
    const row = parsed as Record<string, unknown>;
    if (row.version !== CHART_TOOLS_SCHEMA_VERSION || !row.scopes || typeof row.scopes !== "object" || Array.isArray(row.scopes)) return { version: CHART_TOOLS_SCHEMA_VERSION, scopes: {} };
    const scopes: Record<string, StoredScope> = {};
    for (const [key, value] of Object.entries(row.scopes as Record<string, unknown>)) {
      if (!text(key, 300)) continue;
      const clean = sanitizeChartToolScope(value);
      const updatedAt = value && typeof value === "object" && finite((value as Record<string, unknown>).updatedAt)
        ? (value as Record<string, number>).updatedAt
        : 0;
      if (clean.drawings.length || clean.templates.length) scopes[key] = { ...clean, updatedAt };
    }
    return { version: CHART_TOOLS_SCHEMA_VERSION, scopes };
  } catch {
    return { version: CHART_TOOLS_SCHEMA_VERSION, scopes: {} };
  }
}

export function readChartToolScope(storage: ChartToolStorage | null | undefined, scope: ChartAnnotationScope): ChartToolScope {
  const saved = readDocument(storage).scopes[chartAnnotationScopeKey(scope)];
  return saved ? sanitizeChartToolScope(saved) : { ...EMPTY_SCOPE };
}

export function writeChartToolScope(storage: ChartToolStorage | null | undefined, scope: ChartAnnotationScope, value: ChartToolScope): boolean {
  if (!storage) return false;
  try {
    const document = readDocument(storage);
    const key = chartAnnotationScopeKey(scope);
    const clean = sanitizeChartToolScope(value);
    if (clean.drawings.length || clean.templates.length) document.scopes[key] = { ...clean, updatedAt: Date.now() };
    else delete document.scopes[key];
    const ordered = Object.entries(document.scopes).sort(([, left], [, right]) => right.updatedAt - left.updatedAt).slice(0, MAX_SCOPES);
    document.scopes = Object.fromEntries(ordered);
    storage.setItem(CHART_TOOLS_STORAGE_KEY, JSON.stringify(document));
    return true;
  } catch {
    return false;
  }
}

export function newChartToolId(prefix = "draw") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function pushAnnotationUndo(history: readonly ChartAnnotation[][], current: readonly ChartAnnotation[]) {
  return [...history.slice(-(MAX_UNDO_ENTRIES - 1)), current.map((item) => ({ ...item, start: { ...item.start }, ...(item.end ? { end: { ...item.end } } : {}) }))];
}

export function undoAnnotations(history: readonly ChartAnnotation[][], current: readonly ChartAnnotation[]) {
  if (!history.length) return { drawings: [...current], history: [...history] };
  return { drawings: history[history.length - 1].map((item) => ({ ...item, start: { ...item.start }, ...(item.end ? { end: { ...item.end } } : {}) })), history: history.slice(0, -1) };
}
