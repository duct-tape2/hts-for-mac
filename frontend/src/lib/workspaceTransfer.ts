import { ANALYSIS_SCREENS } from "./analysisScreenCatalog";
import type { IJsonModel } from "flexlayout-react";
import { parseInstrument } from "./api";
import { LINK_GROUPS, readWorkstation, type LinkGroup, type WorkstationState, type WorkstationWorkspace } from "./workstation";
import { isWorkspaceLayout, WORKSPACE_PRESETS, type WorkspacePreset } from "./workspace";
import type { Environment, Instrument, Market, ReadonlyState } from "./types";

/** Portable state only. This deliberately is not a copy of browser storage. */
export const WORKSPACE_TRANSFER_FORMAT = "kiwoom-hts-workspace-transfer";
export const WORKSPACE_TRANSFER_VERSION = 1;
export const MAX_WORKSPACE_TRANSFER_BYTES = 1_048_576;
export const BROWSER_WORKSPACE_BACKUP_KEY = "kiwoom-hts-workspace-transfer-backup-v1";

const MAX_WATCHLISTS = 64;
const MAX_ITEMS_PER_WATCHLIST = 250;
const MAX_ITEMS = 2_000;
const chartIntervals = ["1", "3", "5", "10", "15", "30", "45", "60", "D", "W", "M", "Y"] as const;
const columns = ["name", "code", "last", "change", "changePct", "volume", "open", "high", "low", "prevClose", "venue"] as const;
const captureScreens = ["0198", "0187", "0186", "0184", "0162", "0211", "0602", "0780", "2797", "0200", "0700"] as const;
const components = new Set(["watch", "chart", "book", "history", "details", "notes", "alerts", "rankings", "investors", "capture", "analysis", "comparison", "scanner", "journal", "calculator", "conditions"]);
type JsonRecord = Record<string, unknown>;

export type TransferInstrument = Omit<Instrument, "environment">;
export type TransferWatchlist = { name: string; instruments: TransferInstrument[] };
export type LocalWatchlistImport = { version: 1; watchlists: TransferWatchlist[] };
export type WorkspaceTransfer = { format: typeof WORKSPACE_TRANSFER_FORMAT; version: typeof WORKSPACE_TRANSFER_VERSION; workstation: JsonRecord; watchlists: TransferWatchlist[] };
export type ParsedWorkspaceTransfer = { workstation: WorkstationState; watchlists: TransferWatchlist[] };

function fail(message: string): never { throw new Error(message); }
function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 형식이 올바르지 않습니다.`);
  return value as JsonRecord;
}
function keys(value: JsonRecord, allowed: readonly string[], strict: boolean, label: string) {
  if (strict && Object.keys(value).some((key) => !allowed.includes(key))) fail(`${label}에 허용되지 않은 항목이 있습니다.`);
}
function text(value: unknown, label: string, max = 120): string {
  if (typeof value !== "string" || !value || value.length > max) fail(`${label} 값이 올바르지 않습니다.`);
  return value;
}
function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000) fail(`${label} 값이 올바르지 않습니다.`);
  return value;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} 값이 올바르지 않습니다.`);
  return value;
}
function member<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) fail(`${label} 값이 올바르지 않습니다.`);
  return value as T[number];
}
function linkGroup(value: unknown, label: string): LinkGroup { return member(value, LINK_GROUPS, label); }
function workspacePreset(value: unknown, label: string): WorkspacePreset { return member(value, WORKSPACE_PRESETS, label); }
function primitive(source: JsonRecord, output: JsonRecord, key: string, kind: "string" | "number" | "boolean", label: string) {
  if (source[key] === undefined) return;
  output[key] = kind === "string" ? text(source[key], `${label}.${key}`) : kind === "number" ? number(source[key], `${label}.${key}`) : bool(source[key], `${label}.${key}`);
}

function identity(value: unknown, environment: Environment, strict: boolean, label: string): TransferInstrument {
  const source = record(value, label);
  const allowed = ["market", "stkCd", "stkNm", "stexTp", "listingVenue", "quoteVenue", "currency"];
  keys(source, allowed, strict, label);
  const raw: JsonRecord = {};
  for (const key of allowed) raw[key] = source[key];
  let parsed: Instrument;
  try { parsed = parseInstrument({ ...raw, environment }); } catch { fail(`${label} 종목 식별자가 올바르지 않습니다.`); }
  const output: TransferInstrument = { market: parsed!.market, stkCd: parsed!.stkCd, stkNm: parsed!.stkNm, stexTp: parsed!.stexTp, listingVenue: parsed!.listingVenue, quoteVenue: parsed!.quoteVenue, currency: parsed!.currency };
  if (strict && allowed.some((key) => source[key] !== output[key as keyof TransferInstrument])) fail(`${label} 종목 식별자가 일관되지 않습니다.`);
  return output;
}
function exportIdentity(value: Instrument, label: string): TransferInstrument {
  return identity({ market: value.market, stkCd: value.stkCd, stkNm: value.stkNm, stexTp: value.stexTp, listingVenue: value.listingVenue, quoteVenue: value.quoteVenue, currency: value.currency }, value.environment, false, label);
}
function importedIdentity(value: unknown, environment: Environment, strict: boolean, label: string): Instrument {
  return { ...identity(value, environment, strict, label), environment };
}

function chartPreferences(value: unknown, strict: boolean, label: string): JsonRecord {
  const source = record(value, label);
  const allowed = ["interval", "displayMode", "movingAverages", "showRsi", "showMacd", "showBollingerBands", "volumeRatio", "extendedIndicatorPeriods"];
  keys(source, allowed, strict, label);
  const output: JsonRecord = {};
  if (source.interval !== undefined) output.interval = member(source.interval, chartIntervals, `${label}.interval`);
  if (source.displayMode !== undefined) output.displayMode = member(source.displayMode, ["candles", "line"] as const, `${label}.displayMode`);
  for (const key of ["showRsi", "showMacd", "showBollingerBands"]) if (source[key] !== undefined) output[key] = bool(source[key], `${label}.${key}`);
  if (source.volumeRatio !== undefined) {
    const ratio = number(source.volumeRatio, `${label}.volumeRatio`);
    if (ratio < 0.15 || ratio > 0.45) fail(`${label}.volumeRatio 값이 올바르지 않습니다.`);
    output.volumeRatio = ratio;
  }
  if (source.extendedIndicatorPeriods !== undefined) {
    const periods = record(source.extendedIndicatorPeriods, `${label}.extendedIndicatorPeriods`);
    const periodKeys = ["atr", "adx", "stochastic", "stochasticSignal", "cci"];
    keys(periods, periodKeys, strict, label);
    const next: JsonRecord = {};
    for (const key of periodKeys) if (periods[key] !== undefined) {
      const value = number(periods[key], `${label}.${key}`);
      if (!Number.isInteger(value) || value < (key === "stochasticSignal" ? 1 : 2) || value > (key === "stochasticSignal" ? 50 : 100)) fail(`${label}.${key} 기간이 올바르지 않습니다.`);
      next[key] = value;
    }
    output.extendedIndicatorPeriods = next;
  }
  if (source.movingAverages !== undefined) {
    const ma = record(source.movingAverages, `${label}.movingAverages`);
    keys(ma, ["5", "20", "60", "120", "240"], strict, `${label}.movingAverages`);
    const next: JsonRecord = {};
    for (const key of ["5", "20", "60", "120", "240"]) if (ma[key] !== undefined) next[key] = bool(ma[key], `${label}.movingAverages.${key}`);
    output.movingAverages = next;
  }
  return output;
}
function watchPreferences(value: unknown, strict: boolean, label: string): JsonRecord {
  const source = record(value, label);
  // Group IDs are local references, so they are intentionally not transferable.
  keys(source, ["columns", "sortKey", "sortDirection"], strict, label);
  const output: JsonRecord = {};
  if (source.columns !== undefined) {
    if (!Array.isArray(source.columns) || source.columns.length < 1 || source.columns.length > columns.length) fail(`${label}.columns 값이 올바르지 않습니다.`);
    const next = source.columns.map((entry, index) => member(entry, columns, `${label}.columns[${index}]`));
    if (!next.includes("name") || new Set(next).size !== next.length) fail(`${label}.columns 값이 올바르지 않습니다.`);
    output.columns = next;
  }
  if (source.sortKey !== undefined) output.sortKey = member(source.sortKey, columns, `${label}.sortKey`);
  if (source.sortDirection !== undefined) output.sortDirection = member(source.sortDirection, ["asc", "desc"] as const, `${label}.sortDirection`);
  return output;
}
function capturePreferences(value: unknown, strict: boolean, label: string): JsonRecord {
  const source = record(value, label);
  const allowed = ["market", "venue", "sort", "direction", "interval", "sector", "start", "end", "unit", "period", "tableSort", "tableColumnWidths", "autoRefresh", "newsInstrument", "session", "stock", "credit", "volumeBand", "priceBand", "valueBand", "limitSort", "managed", "localNameOrCode", "localMinPrice", "localMinVolume", "localMinMarketCap", "localMinValue"];
  keys(source, allowed, strict, label);
  const output: JsonRecord = {};
  const choices: Record<string, readonly string[]> = {
    market: ["all", "KOSPI", "KOSDAQ"], venue: ["KRX", "NXT", "ALL"], sort: ["volume", "turnover", "value"], direction: ["up", "down", "rise", "fall", "flat", "previousUpLimit", "previousDownLimit"], interval: ["1", "3", "5", "10", "15", "30", "60", "D", "W", "M", "Y"], unit: ["amount", "volume"], period: ["1", "2", "3", "4", "5"],
    session: ["all", "regular", "preMarket", "afterMarket"],
    stock: ["all", "excludeManaged", "excludePreferred", "excludeManagedPreferred", "excludeEtf", "excludeEtfEtn"],
    credit: ["all", "creditAll", "creditA", "creditB", "creditC", "creditD", "creditE", "loan"],
    volumeBand: ["all", "5k", "10k", "50k", "100k", "150k", "200k", "300k", "500k", "1m"],
    priceBand: ["all", "under1k", "over1k", "1to2k", "2to3k", "2to5k", "over5k", "5to10k", "under10k", "over10k", "over50k", "over100k"],
    valueBand: ["all", "10m", "30m", "50m", "100m", "300m", "500m", "1b", "3b", "5b", "10b", "30b", "50b"],
    limitSort: ["code", "streak", "changePct"], managed: ["exclude", "include"],
  };
  for (const [key, values] of Object.entries(choices)) if (source[key] !== undefined) output[key] = member(source[key], values, `${label}.${key}`);
  if (source.localNameOrCode !== undefined) {
    const value = source.localNameOrCode;
    if (typeof value !== "string" || value.length > 100 || /[\u0000-\u001F\u007F]/.test(value)) fail(`${label}.localNameOrCode 값이 올바르지 않습니다.`);
    output.localNameOrCode = value;
  }
  for (const key of ["localMinPrice", "localMinVolume", "localMinMarketCap", "localMinValue"]) if (source[key] !== undefined) {
    const value = source[key];
    if (typeof value !== "string" || value.length > 24 || (value !== "" && (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))))) fail(`${label}.${key} 값이 올바르지 않습니다.`);
    output[key] = value;
  }
  for (const key of ["sector", "start", "end"]) if (source[key] !== undefined) {
    if (source[key] === "" && key !== "sector") { output[key] = ""; continue; }
    const next = text(source[key], `${label}.${key}`, key === "sector" ? 3 : 8);
    if (!(key === "sector" ? /^\d{3}$/ : /^\d{8}$/).test(next)) fail(`${label}.${key} 값이 올바르지 않습니다.`);
    output[key] = next;
  }
  for (const key of ["autoRefresh", "newsInstrument"]) if (source[key] !== undefined) output[key] = bool(source[key], `${label}.${key}`);
  if (source.tableSort !== undefined) {
    const sort = record(source.tableSort, `${label}.tableSort`); keys(sort, ["key", "direction"], strict, `${label}.tableSort`);
    const key = text(sort.key, `${label}.tableSort.key`, 64);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) fail(`${label}.tableSort.key 값이 올바르지 않습니다.`);
    output.tableSort = { key, direction: member(sort.direction, ["asc", "desc"] as const, `${label}.tableSort.direction`) };
  }
  if (source.tableColumnWidths !== undefined) {
    const widths = record(source.tableColumnWidths, `${label}.tableColumnWidths`);
    if (Object.keys(widths).length > 32) fail(`${label}.tableColumnWidths가 너무 큽니다.`);
    const next: JsonRecord = {};
    for (const [key, value] of Object.entries(widths)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) fail(`${label}.tableColumnWidths 키가 올바르지 않습니다.`);
      const width = number(value, `${label}.tableColumnWidths.${key}`);
      if (width < 56 || width > 420) fail(`${label}.tableColumnWidths 값이 올바르지 않습니다.`);
      next[key] = Math.round(width);
    }
    output.tableColumnWidths = next;
  }
  return output;
}
function tabConfig(value: unknown, component: string, environment: Environment, strict: boolean, label: string): JsonRecord {
  const source = record(value, label);
  const allowed = ["linkGroup", "instrument", ...(component === "comparison" ? ["companions"] : []), ...(component === "analysis" ? ["featureId"] : []), ...(component === "chart" ? ["preferences"] : []), ...(component === "watch" ? ["watchlistPreferences"] : []), ...(component === "capture" ? ["screen", "sector", "sectorPinned", "capturePreferences"] : [])];
  keys(source, allowed, strict, label);
  const output: JsonRecord = {};
  if (source.linkGroup !== undefined) output.linkGroup = linkGroup(source.linkGroup, `${label}.linkGroup`);
  if (component === "comparison" && source.companions !== undefined) {
    if (!Array.isArray(source.companions) || source.companions.length > 3) fail(`${label}.companions 값이 올바르지 않습니다.`);
    output.companions = source.companions.map((item, index) => importedIdentity(item, environment, strict, `${label}.companions[${index}]`));
  }
  if (component === "analysis" && source.featureId !== undefined) output.featureId = member(source.featureId, ANALYSIS_SCREENS.flatMap((screen) => screen.featureId ? [screen.featureId] : []), `${label}.featureId`);
  if (source.instrument !== undefined) output.instrument = importedIdentity(source.instrument, environment, strict, `${label}.instrument`);
  if (component === "chart" && source.preferences !== undefined) output.preferences = chartPreferences(source.preferences, strict, `${label}.preferences`);
  if (component === "watch" && source.watchlistPreferences !== undefined) output.watchlistPreferences = watchPreferences(source.watchlistPreferences, strict, `${label}.watchlistPreferences`);
  if (component === "capture") {
    if (source.screen !== undefined) output.screen = member(source.screen, captureScreens, `${label}.screen`);
    if (source.sector !== undefined) { const sector = text(source.sector, `${label}.sector`, 3); if (!/^\d{3}$/.test(sector)) fail(`${label}.sector 값이 올바르지 않습니다.`); output.sector = sector; }
    if (source.sectorPinned !== undefined) output.sectorPinned = bool(source.sectorPinned, `${label}.sectorPinned`);
    if (source.capturePreferences !== undefined) output.capturePreferences = capturePreferences(source.capturePreferences, strict, `${label}.capturePreferences`);
  }
  return output;
}

function node(value: unknown, environment: Environment, strict: boolean, label: string): JsonRecord {
  const source = record(value, label);
  const type = member(source.type, ["row", "tabset", "tabgroup", "tab"] as const, `${label}.type`);
  const shared = ["type", "id", "weight", "width", "height", "enableClose", "enableDrag", "enableRename", "enableFloat", "enablePopout", "enableDeleteWhenEmpty", "className"];
  const allowed = type === "tab" ? [...shared, "name", "component", "config"] : [...shared, "children", ...(type === "tabset" || type === "tabgroup" ? ["selected"] : [])];
  keys(source, allowed, strict, label);
  const output: JsonRecord = { type };
  primitive(source, output, "id", "string", label);
  for (const key of ["weight", "width", "height"]) primitive(source, output, key, "number", label);
  for (const key of ["enableClose", "enableDrag", "enableRename", "enableFloat", "enablePopout", "enableDeleteWhenEmpty"]) primitive(source, output, key, "boolean", label);
  primitive(source, output, "className", "string", label);
  if (type === "tab") {
    output.name = text(source.name, `${label}.name`);
    const component = text(source.component, `${label}.component`, 40);
    if (!components.has(component)) fail(`${label}.component 값이 올바르지 않습니다.`);
    output.component = component;
    if (source.config !== undefined) output.config = tabConfig(source.config, component, environment, strict, `${label}.config`);
  } else {
    if (!Array.isArray(source.children)) fail(`${label}.children 값이 올바르지 않습니다.`);
    output.children = source.children.map((child, index) => node(child, environment, strict, `${label}.children[${index}]`));
    if (source.selected !== undefined) { if (!Number.isInteger(source.selected) || (source.selected as number) < -1 || (source.selected as number) > 100) fail(`${label}.selected 값이 올바르지 않습니다.`); output.selected = source.selected; }
  }
  return output;
}
function cleanLayout(value: unknown, environment: Environment, strict: boolean, label: string): IJsonModel {
  const source = record(value, label); keys(source, ["global", "borders", "layout", "subLayouts", "popouts"], strict, label);
  const output: JsonRecord = { layout: node(source.layout, environment, strict, `${label}.layout`) };
  if (source.global !== undefined) {
    const global = record(source.global, `${label}.global`);
    const allowed = ["tabEnableClose", "tabEnablePopout", "tabEnableFloat", "tabEnableFloatIcon", "tabSetEnableMaximize", "tabSetMinWidth", "tabSetMinHeight", "tabEnableRename"];
    keys(global, allowed, strict, `${label}.global`);
    const next: JsonRecord = {};
    for (const key of ["tabEnableClose", "tabEnablePopout", "tabEnableFloat", "tabEnableFloatIcon", "tabSetEnableMaximize", "tabEnableRename"]) primitive(global, next, key, "boolean", `${label}.global`);
    for (const key of ["tabSetMinWidth", "tabSetMinHeight"]) primitive(global, next, key, "number", `${label}.global`);
    output.global = next;
  }
  if (source.borders !== undefined) {
    if (!Array.isArray(source.borders) || source.borders.length > 4) fail(`${label}.borders 값이 올바르지 않습니다.`);
    output.borders = source.borders.map((value, index) => {
      const border = record(value, `${label}.borders[${index}]`); keys(border, ["type", "id", "location", "selected", "children"], strict, `${label}.borders[${index}]`);
      const next: JsonRecord = { type: border.type === undefined ? "border" : member(border.type, ["border"] as const, `${label}.borders[${index}].type`), location: member(border.location, ["top", "bottom", "left", "right"] as const, `${label}.borders[${index}].location`) };
      if (border.id !== undefined) next.id = text(border.id, `${label}.borders[${index}].id`);
      if (border.selected !== undefined) { if (!Number.isInteger(border.selected) || (border.selected as number) < -1 || (border.selected as number) > 100) fail(`${label}.borders[${index}].selected 값이 올바르지 않습니다.`); next.selected = border.selected; }
      if (border.children !== undefined) { if (!Array.isArray(border.children)) fail(`${label}.borders[${index}].children 값이 올바르지 않습니다.`); next.children = border.children.map((child, childIndex) => node(child, environment, strict, `${label}.borders[${index}].children[${childIndex}]`)); }
      return next;
    });
  }
  for (const key of ["subLayouts", "popouts"] as const) if (source[key] !== undefined) {
    const layouts = record(source[key], `${label}.${key}`); if (Object.keys(layouts).length > 12) fail(`${label}.${key}가 너무 큽니다.`);
    const next: JsonRecord = {};
    for (const [id, item] of Object.entries(layouts)) {
      text(id, `${label}.${key} id`); const sub = record(item, `${label}.${key}.${id}`); keys(sub, ["type", "rect", "layout"], strict, `${label}.${key}.${id}`);
      const layout: JsonRecord = { layout: node(sub.layout, environment, strict, `${label}.${key}.${id}.layout`) };
      if (sub.type !== undefined) layout.type = member(sub.type, ["window", "float", "tab"] as const, `${label}.${key}.${id}.type`);
      if (sub.rect !== undefined) { const rect = record(sub.rect, `${label}.${key}.${id}.rect`); keys(rect, ["x", "y", "width", "height"], strict, `${label}.${key}.${id}.rect`); layout.rect = { x: number(rect.x, `${label}.${key}.${id}.rect.x`), y: number(rect.y, `${label}.${key}.${id}.rect.y`), width: number(rect.width, `${label}.${key}.${id}.rect.width`), height: number(rect.height, `${label}.${key}.${id}.rect.height`) }; }
      next[id] = layout;
    }
    output[key] = next;
  }
  if (!isWorkspaceLayout(output)) fail(`${label} 배치가 지원되지 않습니다.`);
  return output as unknown as IJsonModel;
}

function workspace(value: unknown, environment: Environment, strict: boolean, label: string): WorkstationWorkspace {
  const source = record(value, label); keys(source, ["id", "name", "preset", "layout", "activeGroup", "instruments", "marketHistory", "savedLayouts"], strict, label);
  const sourceInstruments = record(source.instruments, `${label}.instruments`); keys(sourceInstruments, LINK_GROUPS, strict, `${label}.instruments`);
  const instruments = {} as Record<LinkGroup, Instrument>;
  for (const group of LINK_GROUPS) instruments[group] = importedIdentity(sourceInstruments[group], environment, strict, `${label}.instruments.${group}`);
  const output: WorkstationWorkspace = { id: text(source.id, `${label}.id`, 80), name: text(source.name, `${label}.name`, 24), preset: workspacePreset(source.preset, `${label}.preset`), layout: cleanLayout(source.layout, environment, strict, `${label}.layout`), activeGroup: linkGroup(source.activeGroup, `${label}.activeGroup`), instruments };
  if (source.marketHistory !== undefined) {
    const sourceHistory = record(source.marketHistory, `${label}.marketHistory`); keys(sourceHistory, LINK_GROUPS, strict, `${label}.marketHistory`);
    const history: NonNullable<WorkstationWorkspace["marketHistory"]> = {};
    for (const [group, markets] of Object.entries(sourceHistory)) {
      linkGroup(group, `${label}.marketHistory group`); const sourceMarkets = record(markets, `${label}.marketHistory.${group}`); keys(sourceMarkets, ["KR", "US"], strict, `${label}.marketHistory.${group}`);
      const next: Partial<Record<Market, Instrument>> = {};
      for (const market of ["KR", "US"] as const) if (sourceMarkets[market] !== undefined) { const item = importedIdentity(sourceMarkets[market], environment, strict, `${label}.marketHistory.${group}.${market}`); if (item.market !== market) fail(`${label}.marketHistory 시장이 일관되지 않습니다.`); next[market] = item; }
      history[group as LinkGroup] = next;
    }
    output.marketHistory = history;
  }
  if (source.savedLayouts !== undefined) {
    const sourceLayouts = record(source.savedLayouts, `${label}.savedLayouts`); keys(sourceLayouts, WORKSPACE_PRESETS, strict, `${label}.savedLayouts`);
    const saved: NonNullable<WorkstationWorkspace["savedLayouts"]> = {};
    for (const [name, savedLayout] of Object.entries(sourceLayouts)) saved[workspacePreset(name, `${label}.savedLayouts preset`)] = cleanLayout(savedLayout, environment, strict, `${label}.savedLayouts.${name}`);
    output.savedLayouts = saved;
  }
  return output;
}
function transferLayout(value: IJsonModel): IJsonModel {
  const output = JSON.parse(JSON.stringify(value)) as JsonRecord;
  const visit = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const node = entry as JsonRecord;
    if (node.config && typeof node.config === "object" && !Array.isArray(node.config)) {
      const config = node.config as JsonRecord;
      if (config.instrument && typeof config.instrument === "object" && !Array.isArray(config.instrument)) delete (config.instrument as JsonRecord).environment;
      if (Array.isArray(config.companions)) for (const item of config.companions) {
        if (item && typeof item === "object") delete (item as JsonRecord).environment;
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(output.layout);
  if (Array.isArray(output.borders)) for (const border of output.borders) visit(border);
  for (const key of ["subLayouts", "popouts"]) {
    const layouts = output[key];
    if (!layouts || typeof layouts !== "object" || Array.isArray(layouts)) continue;
    for (const item of Object.values(layouts as JsonRecord)) {
      if (item && typeof item === "object" && !Array.isArray(item)) visit((item as JsonRecord).layout);
    }
  }
  return output as unknown as IJsonModel;
}
function toTransferWorkspace(value: WorkstationWorkspace): JsonRecord {
  const exported = workspace({
    id: value.id, name: value.name, preset: value.preset, layout: value.layout, activeGroup: value.activeGroup,
    instruments: Object.fromEntries(LINK_GROUPS.map((group) => [group, exportIdentity(value.instruments[group], `workspace.${value.id}`)])),
    ...(value.marketHistory === undefined ? {} : { marketHistory: Object.fromEntries(Object.entries(value.marketHistory).map(([group, markets]) => [group, Object.fromEntries(Object.entries(markets).map(([market, item]) => [market, exportIdentity(item!, `workspace.${value.id}`)]))])) }),
    ...(value.savedLayouts === undefined ? {} : { savedLayouts: value.savedLayouts }),
  }, "fixture", false, `workspace.${value.id}`);
  const asTransfer = (item: Instrument) => exportIdentity(item, `workspace.${value.id}`);
  return { ...exported, layout: transferLayout(exported.layout), instruments: Object.fromEntries(LINK_GROUPS.map((group) => [group, asTransfer(exported.instruments[group])])), ...(exported.marketHistory === undefined ? {} : { marketHistory: Object.fromEntries(Object.entries(exported.marketHistory).map(([group, markets]) => [group, Object.fromEntries(Object.entries(markets).map(([market, item]) => [market, asTransfer(item!)]))])) }), ...(exported.savedLayouts === undefined ? {} : { savedLayouts: Object.fromEntries(Object.entries(exported.savedLayouts).map(([name, saved]) => [name, transferLayout(saved!)])) }) };
}
function cleanWatchlists(value: unknown, environment: Environment, strict: boolean): TransferWatchlist[] {
  if (!Array.isArray(value) || value.length > MAX_WATCHLISTS) fail("관심종목 그룹 수가 올바르지 않습니다.");
  let total = 0; const names = new Set<string>();
  return value.map((entry, index) => {
    const source = record(entry, `watchlists[${index}]`); keys(source, ["name", "instruments"], strict, `watchlists[${index}]`);
    const name = text(source.name, `watchlists[${index}].name`, 80).trim();
    if (!name || names.has(name.toLocaleLowerCase())) fail("관심종목 그룹 이름이 중복되었거나 올바르지 않습니다.");
    names.add(name.toLocaleLowerCase());
    if (!Array.isArray(source.instruments) || source.instruments.length > MAX_ITEMS_PER_WATCHLIST) fail(`watchlists[${index}].instruments 값이 올바르지 않습니다.`);
    total += source.instruments.length; if (total > MAX_ITEMS) fail("관심종목 수가 너무 많습니다.");
    const instruments = source.instruments.map((item, itemIndex) => identity(item, environment, strict, `watchlists[${index}].instruments[${itemIndex}]`));
    const identities = new Set(instruments.map((item) => `${item.market}:${item.stkCd}:${item.listingVenue}:${item.quoteVenue}`));
    if (identities.size !== instruments.length) fail(`watchlists[${index}]에 중복 종목이 있습니다.`);
    return { name, instruments };
  });
}

/** Exports only known layout/display fields and identity data; quotes and credentials cannot enter the document. */
export function createWorkspaceTransfer(bundle: WorkstationState, state: ReadonlyState): WorkspaceTransfer {
  const checked = readWorkstation(JSON.stringify(bundle));
  if (!checked) fail("현재 작업공간 상태가 올바르지 않습니다.");
  const groups = state.watchlists.map((group) => ({ name: group.name, instruments: state.items.filter((item) => item.watchlistId === group.id).map((item) => exportIdentity(item, `watchlist.${group.id}`)) }));
  const output: WorkspaceTransfer = { format: WORKSPACE_TRANSFER_FORMAT, version: WORKSPACE_TRANSFER_VERSION, workstation: { version: 2, activeId: checked.activeId, workspaces: checked.workspaces.map(toTransferWorkspace) }, watchlists: cleanWatchlists(groups, state.mode, false) };
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > MAX_WORKSPACE_TRANSFER_BYTES) fail("내보낼 파일이 1MiB를 초과합니다.");
  return output;
}
/** Parses fully before state mutation and reattaches every identity to this runtime environment. */
export function parseWorkspaceTransfer(raw: string, environment: Environment): ParsedWorkspaceTransfer {
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_WORKSPACE_TRANSFER_BYTES) fail("가져올 파일은 1MiB 이하여야 합니다.");
  let source: unknown; try { source = JSON.parse(raw); } catch { fail("가져올 파일이 JSON 형식이 아닙니다."); }
  const transfer = record(source, "transfer"); keys(transfer, ["format", "version", "workstation", "watchlists"], true, "transfer");
  if (transfer.format !== WORKSPACE_TRANSFER_FORMAT || transfer.version !== WORKSPACE_TRANSFER_VERSION) fail("지원되지 않는 작업공간 전송 파일입니다.");
  const sourceWorkstation = record(transfer.workstation, "workstation"); keys(sourceWorkstation, ["version", "activeId", "workspaces"], true, "workstation");
  if (sourceWorkstation.version !== 2 || !Array.isArray(sourceWorkstation.workspaces) || sourceWorkstation.workspaces.length !== 4) fail("작업공간 수 또는 버전이 올바르지 않습니다.");
  const next: WorkstationState = { version: 2, activeId: text(sourceWorkstation.activeId, "workstation.activeId", 80), workspaces: sourceWorkstation.workspaces.map((item, index) => workspace(item, environment, true, `workstation.workspaces[${index}]`)) };
  const checked = readWorkstation(JSON.stringify(next));
  if (!checked) fail("작업공간 배치를 검증하지 못했습니다.");
  return { workstation: checked, watchlists: cleanWatchlists(transfer.watchlists, environment, true) };
}
