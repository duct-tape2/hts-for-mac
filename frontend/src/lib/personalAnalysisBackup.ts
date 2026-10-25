import { CHART_TOOLS_SCHEMA_VERSION, CHART_TOOLS_STORAGE_KEY, sanitizeChartToolScope, type ChartToolScope } from "./chartAnnotations";

export const PERSONAL_ANALYSIS_BACKUP_VERSION = 1;
export const PERSONAL_ANALYSIS_BACKUP_MAX_BYTES = 1024 * 1024;
const MAX_NOTES = 500;
const MAX_NOTE_LENGTH = 20_000;
const MAX_SCOPES = 48;
const MAX_STORAGE_KEYS = 10_000;

export type PersonalAnalysisStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
export type PersonalAnalysisNote = { market: "KR" | "US"; stkCd: string; text: string };
export type PersonalAnalysisBackup = {
  version: typeof PERSONAL_ANALYSIS_BACKUP_VERSION;
  notes: PersonalAnalysisNote[];
  chartTools: { version: typeof CHART_TOOLS_SCHEMA_VERSION; scopes: Record<string, ChartToolScope> };
};
export type PersonalAnalysisCounts = { notes: number; scopes: number; drawings: number; templates: number };
export type PersonalAnalysisConflicts = { notes: number; scopes: number; drawings: number; templates: number };

const noteKey = /^hts-note:(KR|US):([A-Z0-9.]{1,15})$/;

function byteLength(value: string) { return new TextEncoder().encode(value).byteLength; }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function exactKeys(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function safeText(value: unknown, maximum: number, allowNewlines = false): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && (allowNewlines
    ? !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    : !/[\u0000-\u001f\u007f]/.test(value));
}
function safeScopeKey(value: unknown): value is string { return safeText(value, 300) && value.trim() === value; }
function noteStorageKey(note: PersonalAnalysisNote) { return `hts-note:${note.market}:${note.stkCd}`; }
function validCode(market: "KR" | "US", code: string) { return market === "KR" ? /^[0-9A-Z]{6}$/.test(code) : /^[A-Z][A-Z0-9.]{0,14}$/.test(code); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = object(value);
  if (row) return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function strictChartScope(value: unknown): ChartToolScope | null {
  const row = object(value);
  if (!row || !exactKeys(row, ["drawings", "templates"]) || !Array.isArray(row.drawings) || !Array.isArray(row.templates)) return null;
  const clean = sanitizeChartToolScope(row);
  return canonical(clean) === canonical(row) ? clean : null;
}

function readStoredChartScopes(storage: Pick<PersonalAnalysisStorage, "getItem">): Record<string, ChartToolScope> {
  const raw = storage.getItem(CHART_TOOLS_STORAGE_KEY);
  if (!raw) return {};
  if (byteLength(raw) > PERSONAL_ANALYSIS_BACKUP_MAX_BYTES) throw new Error("저장된 차트 도구 데이터가 1 MiB 제한을 넘습니다.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("저장된 차트 도구 데이터가 손상되었습니다."); }
  const document = object(parsed);
  if (!document || !exactKeys(document, ["version", "scopes"]) || document.version !== CHART_TOOLS_SCHEMA_VERSION) throw new Error("저장된 차트 도구 형식이 올바르지 않습니다.");
  const scopes = object(document.scopes);
  if (!scopes || Object.keys(scopes).length > MAX_SCOPES) throw new Error("저장된 차트 도구 범위가 올바르지 않습니다.");
  const cleaned: Record<string, ChartToolScope> = {};
  for (const [scopeKey, stored] of Object.entries(scopes)) {
    const row = object(stored);
    if (!safeScopeKey(scopeKey) || !row || !exactKeys(row, ["drawings", "templates", "updatedAt"]) || typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) {
      throw new Error("저장된 차트 도구 항목이 올바르지 않습니다.");
    }
    const scope = strictChartScope({ drawings: row.drawings, templates: row.templates });
    if (!scope) throw new Error("저장된 차트 도구 항목이 올바르지 않습니다.");
    cleaned[scopeKey] = scope;
  }
  return cleaned;
}

function parseNote(value: unknown): PersonalAnalysisNote | null {
  const row = object(value);
  if (!row || !exactKeys(row, ["market", "stkCd", "text"]) || (row.market !== "KR" && row.market !== "US") || typeof row.stkCd !== "string" || !safeText(row.text, MAX_NOTE_LENGTH, true) || !validCode(row.market, row.stkCd)) return null;
  return { market: row.market, stkCd: row.stkCd, text: row.text };
}

export function backupCounts(backup: PersonalAnalysisBackup): PersonalAnalysisCounts {
  const scopes = Object.values(backup.chartTools.scopes);
  return { notes: backup.notes.length, scopes: scopes.length, drawings: scopes.reduce((total, scope) => total + scope.drawings.length, 0), templates: scopes.reduce((total, scope) => total + scope.templates.length, 0) };
}

export function createPersonalAnalysisBackup(storage: PersonalAnalysisStorage): PersonalAnalysisBackup {
  if (storage.length > MAX_STORAGE_KEYS) throw new Error("브라우저 저장 항목이 너무 많아 안전하게 백업할 수 없습니다.");
  const notes: PersonalAnalysisNote[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    const match = key?.match(noteKey);
    if (!match || !key) continue;
    const text = storage.getItem(key);
    const note = parseNote({ market: match[1], stkCd: match[2], text });
    if (note) {
      notes.push(note);
      if (notes.length > MAX_NOTES) throw new Error("백업할 분석 메모가 500개 제한을 넘습니다.");
    }
  }
  notes.sort((left, right) => noteStorageKey(left).localeCompare(noteStorageKey(right)));
  const backup: PersonalAnalysisBackup = { version: PERSONAL_ANALYSIS_BACKUP_VERSION, notes, chartTools: { version: CHART_TOOLS_SCHEMA_VERSION, scopes: readStoredChartScopes(storage) } };
  if (byteLength(JSON.stringify(backup)) > PERSONAL_ANALYSIS_BACKUP_MAX_BYTES) throw new Error("백업 데이터가 1 MiB 제한을 넘습니다.");
  return backup;
}

export function parsePersonalAnalysisBackup(raw: string): PersonalAnalysisBackup {
  if (byteLength(raw) > PERSONAL_ANALYSIS_BACKUP_MAX_BYTES) throw new Error("백업 파일이 1 MiB 제한을 넘습니다.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("백업 JSON 형식이 올바르지 않습니다."); }
  const row = object(value);
  if (!row || !exactKeys(row, ["version", "notes", "chartTools"]) || row.version !== PERSONAL_ANALYSIS_BACKUP_VERSION || !Array.isArray(row.notes) || row.notes.length > MAX_NOTES) {
    throw new Error("백업 스키마가 올바르지 않습니다.");
  }
  const notes = row.notes.map(parseNote);
  if (notes.some((note) => !note)) throw new Error("백업 메모 형식이 올바르지 않습니다.");
  const uniqueNotes = new Set<string>();
  for (const note of notes as PersonalAnalysisNote[]) {
    const key = noteStorageKey(note);
    if (uniqueNotes.has(key)) throw new Error("백업 메모가 중복됩니다.");
    uniqueNotes.add(key);
  }
  const charts = object(row.chartTools);
  if (!charts || !exactKeys(charts, ["version", "scopes"]) || charts.version !== CHART_TOOLS_SCHEMA_VERSION) throw new Error("차트 도구 백업 형식이 올바르지 않습니다.");
  const rawScopes = object(charts.scopes);
  if (!rawScopes || Object.keys(rawScopes).length > MAX_SCOPES) throw new Error("차트 도구 범위가 올바르지 않습니다.");
  const scopes: Record<string, ChartToolScope> = {};
  for (const [scopeKey, scopeValue] of Object.entries(rawScopes)) {
    const scope = safeScopeKey(scopeKey) ? strictChartScope(scopeValue) : null;
    if (!scope || Object.hasOwn(scopes, scopeKey)) throw new Error("차트 도구 항목이 올바르지 않습니다.");
    scopes[scopeKey] = scope;
  }
  const backup: PersonalAnalysisBackup = { version: PERSONAL_ANALYSIS_BACKUP_VERSION, notes: notes as PersonalAnalysisNote[], chartTools: { version: CHART_TOOLS_SCHEMA_VERSION, scopes } };
  if (byteLength(JSON.stringify(backup)) > PERSONAL_ANALYSIS_BACKUP_MAX_BYTES) throw new Error("백업 파일이 1 MiB 제한을 넘습니다.");
  return backup;
}

function mergeScope(existing: ChartToolScope | undefined, incoming: ChartToolScope): ChartToolScope {
  const merge = <T extends { id: string }>(current: T[] = [], added: T[]) => {
    const next = new Map(current.map((item) => [item.id, item]));
    added.forEach((item) => next.set(item.id, item));
    return [...next.values()];
  };
  return { drawings: merge(existing?.drawings, incoming.drawings), templates: merge(existing?.templates, incoming.templates) };
}

export function backupConflicts(storage: PersonalAnalysisStorage, backup: PersonalAnalysisBackup): PersonalAnalysisConflicts {
  const currentScopes = readStoredChartScopes(storage);
  let drawings = 0, templates = 0;
  for (const [scopeKey, incoming] of Object.entries(backup.chartTools.scopes)) {
    const current = currentScopes[scopeKey];
    if (!current) continue;
    const drawingsById = new Set(current.drawings.map((item) => item.id));
    const templatesById = new Set(current.templates.map((item) => item.id));
    drawings += incoming.drawings.filter((item) => drawingsById.has(item.id)).length;
    templates += incoming.templates.filter((item) => templatesById.has(item.id)).length;
  }
  return {
    notes: backup.notes.filter((note) => storage.getItem(noteStorageKey(note)) !== null).length,
    scopes: Object.keys(backup.chartTools.scopes).filter((key) => Object.hasOwn(currentScopes, key)).length,
    drawings,
    templates,
  };
}

export function restorePersonalAnalysisBackup(storage: PersonalAnalysisStorage, backup: PersonalAnalysisBackup): PersonalAnalysisCounts {
  const checked = parsePersonalAnalysisBackup(JSON.stringify(backup));
  const currentScopes = readStoredChartScopes(storage);
  const mergedScopes = { ...currentScopes };
  for (const [scopeKey, incoming] of Object.entries(checked.chartTools.scopes)) {
    const merged = mergeScope(currentScopes[scopeKey], incoming);
    // Do not silently trim existing drawings/templates during a restore.
    if (canonical(sanitizeChartToolScope(merged)) !== canonical(merged)) throw new Error("병합 후 차트 도구 항목이 허용 한도를 넘습니다.");
    mergedScopes[scopeKey] = merged;
  }
  if (Object.keys(mergedScopes).length > MAX_SCOPES) throw new Error("병합 후 차트 도구 범위가 허용 한도를 넘습니다.");
  const chartDocument = {
    version: CHART_TOOLS_SCHEMA_VERSION,
    scopes: Object.fromEntries(Object.entries(mergedScopes).map(([scopeKey, scope]) => [scopeKey, { ...scope, updatedAt: Date.now() }])),
  };
  const chartRaw = JSON.stringify(chartDocument);
  if (byteLength(chartRaw) > PERSONAL_ANALYSIS_BACKUP_MAX_BYTES) throw new Error("병합 후 차트 도구 데이터가 1 MiB 제한을 넘습니다.");
  const writes: Array<{ key: string; value: string }> = [
    ...checked.notes.map((note) => ({ key: noteStorageKey(note), value: note.text })),
    ...(Object.keys(checked.chartTools.scopes).length ? [{ key: CHART_TOOLS_STORAGE_KEY, value: chartRaw }] : []),
  ];
  const before = new Map(writes.map((write) => [write.key, storage.getItem(write.key)]));
  try {
    for (const write of writes) storage.setItem(write.key, write.value);
  } catch {
    for (const write of writes) {
      const previous = before.get(write.key);
      try { previous === null || previous === undefined ? storage.removeItem(write.key) : storage.setItem(write.key, previous); } catch { /* Preserve the original write failure as the actionable error. */ }
    }
    throw new Error("복원에 실패해 기존 데이터를 되돌렸습니다.");
  }
  return backupCounts(checked);
}
