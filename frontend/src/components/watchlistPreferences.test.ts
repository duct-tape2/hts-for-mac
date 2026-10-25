import { describe, expect, it } from "vitest";
import { DEFAULT_WATCHLIST_PREFERENCES, sanitizeWatchlistPreferences } from "@/components/watchlistPreferences";

describe("sanitizeWatchlistPreferences", () => {
  it("keeps the original visible-field defaults", () => {
    expect(sanitizeWatchlistPreferences()).toEqual(DEFAULT_WATCHLIST_PREFERENCES);
  });

  it("drops unknown and duplicate columns while retaining name first", () => {
    const input = { columns: ["volume", "volume", "not-a-column", "last"] } as never;
    expect(sanitizeWatchlistPreferences(input).columns).toEqual(["name", "volume", "last"]);
  });

  it("falls back to supported sorting values without mutating the input", () => {
    const input = { groupId: "wl-us", columns: ["name", "venue"], sortKey: "not-a-sort", sortDirection: "sideways" } as never;
    const snapshot = JSON.stringify(input);
    expect(sanitizeWatchlistPreferences(input)).toEqual({
      groupId: "wl-us",
      columns: ["name", "venue"],
      sortKey: "name",
      sortDirection: "asc",
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
