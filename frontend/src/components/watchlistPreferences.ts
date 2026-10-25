export const WATCHLIST_COLUMNS = [
  "name",
  "code",
  "last",
  "change",
  "changePct",
  "volume",
  "open",
  "high",
  "low",
  "prevClose",
  "venue",
] as const;

export type WatchlistColumn = (typeof WATCHLIST_COLUMNS)[number];

export const WATCHLIST_SORT_KEYS = WATCHLIST_COLUMNS;
export type WatchlistSortKey = (typeof WATCHLIST_SORT_KEYS)[number];
export type WatchlistSortDirection = "asc" | "desc";

export type WatchlistPreferences = {
  groupId: string;
  columns: WatchlistColumn[];
  sortKey: WatchlistSortKey;
  sortDirection: WatchlistSortDirection;
};

export const DEFAULT_WATCHLIST_PREFERENCES: WatchlistPreferences = {
  groupId: "",
  columns: ["name", "code", "last", "changePct", "volume"],
  sortKey: "name",
  sortDirection: "asc",
};

const knownColumns = new Set<string>(WATCHLIST_COLUMNS);

function isWatchlistColumn(value: unknown): value is WatchlistColumn {
  return typeof value === "string" && knownColumns.has(value);
}

function isWatchlistSortKey(value: unknown): value is WatchlistSortKey {
  return isWatchlistColumn(value);
}

/**
 * Normalize persisted or partially supplied panel preferences at the UI boundary.
 * Unknown and duplicate columns are discarded, while the name column is always
 * retained as the first column. The input is never mutated.
 */
export function sanitizeWatchlistPreferences(input?: Partial<WatchlistPreferences> | null): WatchlistPreferences {
  const source = input ?? {};
  const columns = Array.isArray(source.columns) ? source.columns : DEFAULT_WATCHLIST_PREFERENCES.columns;
  const seen = new Set<WatchlistColumn>();
  const validColumns: WatchlistColumn[] = [];

  for (const value of columns) {
    if (!isWatchlistColumn(value) || seen.has(value)) continue;
    seen.add(value);
    validColumns.push(value);
  }

  const withoutName = validColumns.filter((column) => column !== "name");
  const normalizedColumns: WatchlistColumn[] = ["name", ...withoutName];

  return {
    groupId: typeof source.groupId === "string" ? source.groupId : DEFAULT_WATCHLIST_PREFERENCES.groupId,
    columns: normalizedColumns,
    sortKey: isWatchlistSortKey(source.sortKey) ? source.sortKey : DEFAULT_WATCHLIST_PREFERENCES.sortKey,
    sortDirection: source.sortDirection === "desc" ? "desc" : DEFAULT_WATCHLIST_PREFERENCES.sortDirection,
  };
}
