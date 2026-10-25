import type { IJsonModel } from "flexlayout-react";
import { parseInstrument } from "./api";
import { defaultInstrument } from "./symbols";
import type { Environment, Instrument, Market } from "./types";
import {
  isWorkspaceLayout,
  workspaceLayout,
  WORKSPACE_PRESETS,
  type WorkspacePreset,
} from "./workspace";

export type LinkGroup = "1" | "2" | "3" | "4";
export const LINK_GROUPS: readonly LinkGroup[] = ["1", "2", "3", "4"];
export const WORKSTATION_KEY = "kiwoom-hts-workstation-v2";

export type WorkstationWorkspace = {
  id: string;
  name: string;
  preset: WorkspacePreset;
  layout: IJsonModel;
  activeGroup: LinkGroup;
  instruments: Record<LinkGroup, Instrument>;
  marketHistory?: Partial<
    Record<LinkGroup, Partial<Record<Market, Instrument>>>
  >;
  savedLayouts?: Partial<Record<WorkspacePreset, IJsonModel>>;
};

export type WorkstationState = {
  version: 2;
  activeId: string;
  workspaces: WorkstationWorkspace[];
};

const MAX_WORKSTATION_BYTES = 1_000_000;
const MAX_WORKSPACES = 4;
const MAX_NAME_LENGTH = 24;
const workspaceNames = ["국내 관찰", "미국 관찰", "비교 분석", "자유 화면"] as const;
// This is used only when no v2 workspace has been restored. Existing saved
// workspaces keep their preset and exact FlexLayout JSON untouched.
const workspacePresets: WorkspacePreset[] = ["rankings", "terminal", "dual", "quad"];

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneInstrument(instrument: Instrument): Instrument {
  return { ...instrument };
}

function groupInstruments(instrument: Instrument): Record<LinkGroup, Instrument> {
  return {
    "1": cloneInstrument(instrument),
    "2": cloneInstrument(instrument),
    "3": cloneInstrument(instrument),
    "4": cloneInstrument(instrument),
  };
}

function marketHistoryForGroups(
  instruments: Record<LinkGroup, Instrument>,
): NonNullable<WorkstationWorkspace["marketHistory"]> {
  return LINK_GROUPS.reduce<NonNullable<WorkstationWorkspace["marketHistory"]>>(
    (history, group) => ({
      ...history,
      [group]: { [instruments[group].market]: cloneInstrument(instruments[group]) },
    }),
    {},
  );
}

function isLinkGroup(value: unknown): value is LinkGroup {
  return typeof value === "string" && (LINK_GROUPS as readonly string[]).includes(value);
}

function isPreset(value: unknown): value is WorkspacePreset {
  return typeof value === "string" && (WORKSPACE_PRESETS as readonly string[]).includes(value);
}

function isMarket(value: unknown): value is Market {
  return value === "KR" || value === "US";
}

function presetForLayout(layout: IJsonModel): WorkspacePreset {
  let charts = 0;
  const visit = (node: unknown) => {
    if (!record(node)) return;
    if (node.component === "chart") charts += 1;
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(layout.layout);
  for (const layouts of [layout.subLayouts, layout.popouts]) {
    if (!layouts) continue;
    for (const subLayout of Object.values(layouts)) {
      if (record(subLayout)) visit(subLayout.layout);
    }
  }
  return charts >= 4 ? "quad" : charts >= 2 ? "dual" : "terminal";
}

function validWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 80;
}

function validWorkspaceName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_NAME_LENGTH;
}

function parseGroups(value: unknown): Record<LinkGroup, Instrument> | null {
  if (!record(value) || Object.keys(value).length !== LINK_GROUPS.length) return null;
  const instruments = {} as Record<LinkGroup, Instrument>;
  try {
    for (const group of LINK_GROUPS) {
      if (!(group in value)) return null;
      instruments[group] = parseInstrument(value[group]);
    }
  } catch {
    return null;
  }
  return instruments;
}

function parseMarketHistory(
  value: unknown,
): NonNullable<WorkstationWorkspace["marketHistory"]> | null {
  if (!record(value)) return null;
  const history: NonNullable<WorkstationWorkspace["marketHistory"]> = {};
  try {
    for (const [group, markets] of Object.entries(value)) {
      if (!isLinkGroup(group) || !record(markets)) return null;
      const groupHistory: Partial<Record<Market, Instrument>> = {};
      for (const [market, instrument] of Object.entries(markets)) {
        if (!isMarket(market)) return null;
        const parsed = parseInstrument(instrument);
        if (parsed.market !== market) return null;
        groupHistory[market] = parsed;
      }
      history[group] = groupHistory;
    }
  } catch {
    return null;
  }
  return history;
}

function parseWorkspace(value: unknown): WorkstationWorkspace | null {
  if (!record(value)) return null;
  if (
    !validWorkspaceId(value.id) ||
    !validWorkspaceName(value.name) ||
    !isPreset(value.preset) ||
    !isWorkspaceLayout(value.layout) ||
    !isLinkGroup(value.activeGroup)
  )
    return null;
  const instruments = parseGroups(value.instruments);
  if (!instruments) return null;
  let marketHistory: NonNullable<WorkstationWorkspace["marketHistory"]> | undefined;
  if (value.marketHistory !== undefined) {
    const parsed = parseMarketHistory(value.marketHistory);
    if (!parsed) return null;
    marketHistory = parsed;
  }
  let savedLayouts: WorkstationWorkspace["savedLayouts"];
  if (value.savedLayouts !== undefined) {
    if (!record(value.savedLayouts) || Object.keys(value.savedLayouts).length > WORKSPACE_PRESETS.length) return null;
    savedLayouts = {};
    for (const [preset, layout] of Object.entries(value.savedLayouts)) {
      if (!isPreset(preset) || !isWorkspaceLayout(layout)) return null;
      savedLayouts[preset] = layout;
    }
  }
  return {
    id: value.id,
    name: value.name,
    preset: value.preset,
    layout: value.layout,
    activeGroup: value.activeGroup,
    instruments,
    ...(marketHistory === undefined ? {} : { marketHistory }),
    ...(savedLayouts === undefined ? {} : { savedLayouts }),
  };
}

function updateMatching(
  state: WorkstationState,
  id: string,
  update: (workspace: WorkstationWorkspace) => WorkstationWorkspace,
): WorkstationState {
  const index = state.workspaces.findIndex((workspace) => workspace.id === id);
  if (index < 0) return state;
  const workspaces = state.workspaces.slice();
  workspaces[index] = update(workspaces[index]);
  return { ...state, workspaces };
}

export function createWorkstation(
  environment: Environment,
  legacyLayout: IJsonModel | null = null,
  legacyInstrument: Instrument | null = null,
): WorkstationState {
  const defaults = [
    legacyInstrument ? cloneInstrument(legacyInstrument) : defaultInstrument("KR", environment),
    defaultInstrument("US", environment),
    defaultInstrument("KR", environment),
    defaultInstrument("KR", environment),
  ];
  const workspaces = workspaceNames.map((name, index) => {
    const preset =
      index === 0 && legacyLayout
        ? presetForLayout(legacyLayout)
        : workspacePresets[index];
    const instruments = groupInstruments(defaults[index]);
    return {
      id: `workspace-${index + 1}`,
      name,
      preset,
      layout: index === 0 && legacyLayout ? legacyLayout : workspaceLayout(preset),
      activeGroup: "1" as const,
      instruments,
      marketHistory: marketHistoryForGroups(instruments),
    };
  });
  return { version: 2, activeId: workspaces[0].id, workspaces };
}

export function readWorkstation(value: string | null): WorkstationState | null {
  try {
    if (!value || value.length > MAX_WORKSTATION_BYTES) return null;
    const stored = JSON.parse(value);
    if (
      !record(stored) ||
      stored.version !== 2 ||
      !Array.isArray(stored.workspaces) ||
      stored.workspaces.length !== MAX_WORKSPACES ||
      !validWorkspaceId(stored.activeId)
    )
      return null;
    const workspaces = stored.workspaces.map(parseWorkspace);
    if (workspaces.some((workspace) => workspace === null)) return null;
    const validWorkspaces = workspaces as WorkstationWorkspace[];
    const ids = new Set(validWorkspaces.map((workspace) => workspace.id));
    if (ids.size !== validWorkspaces.length || !ids.has(stored.activeId)) return null;
    return { version: 2, activeId: stored.activeId, workspaces: validWorkspaces };
  } catch {
    return null;
  }
}

export function updateWorkspace(
  state: WorkstationState,
  id: string,
  patch: Partial<Omit<WorkstationWorkspace, "id">>,
): WorkstationState {
  return updateMatching(state, id, (workspace) => ({ ...workspace, ...patch }));
}

export function selectWorkspace(
  state: WorkstationState,
  id: string,
): WorkstationState {
  if (!state.workspaces.some((workspace) => workspace.id === id)) return state;
  if (state.activeId === id) return state;
  return { ...state, activeId: id };
}

export function setGroupInstrument(
  state: WorkstationState,
  id: string,
  group: LinkGroup,
  instrument: Instrument,
): WorkstationState {
  if (!isLinkGroup(group)) return state;
  return updateMatching(state, id, (workspace) => ({
    ...workspace,
    instruments: { ...workspace.instruments, [group]: cloneInstrument(instrument) },
    marketHistory: {
      ...workspace.marketHistory,
      [group]: {
        ...workspace.marketHistory?.[group],
        [workspace.instruments[group].market]: cloneInstrument(
          workspace.instruments[group],
        ),
        [instrument.market]: cloneInstrument(instrument),
      },
    },
  }));
}

export function instrumentForMarket(
  workspace: WorkstationWorkspace,
  group: LinkGroup,
  market: Market,
  environment: Environment,
): Instrument {
  const current = workspace.instruments[group];
  if (current.market === market) return { ...current, environment };
  const historical = workspace.marketHistory?.[group]?.[market];
  if (historical) return { ...historical, environment };
  return defaultInstrument(market, environment);
}

export function renameWorkspace(
  state: WorkstationState,
  id: string,
  name: string,
): WorkstationState {
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  if (!trimmed) return state;
  return updateMatching(state, id, (workspace) =>
    workspace.name === trimmed ? workspace : { ...workspace, name: trimmed },
  );
}
