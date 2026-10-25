import type { IJsonModel, IJsonTabNode } from "flexlayout-react";

export const WORKSPACE_PRESETS = ["terminal", "dual", "quad", "capture", "rankings", "charts", "markets", "news"] as const;
export type WorkspacePreset = typeof WORKSPACE_PRESETS[number];
export function isCapturePreset(preset: WorkspacePreset) { return ["capture", "rankings", "charts", "markets", "news"].includes(preset); }
export const WORKSPACE_KEY = "kiwoom-hts-layout-v1";
const MAX_WORKSPACE_BYTES = 250000;
const MAX_LAYOUT_NODES = 60;
const MAX_LAYOUT_DEPTH = 12;
const MAX_SUB_LAYOUTS = 12;
const allowedComponents = new Set([
  "watch",
  "chart",
  "book",
  "history",
  "details",
  "notes",
  "alerts",
  "rankings",
  "investors",
  "analysis", "comparison", "scanner", "calculator", "journal", "conditions",
  "capture",
]);
const allowedBorderLocations = new Set(["top", "bottom", "left", "right"]);
const allowedSubLayoutTypes = new Set(["window", "float", "tab"]);

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown, ids: Set<string>): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || !value || value.length > 120 || ids.has(value))
    return false;
  ids.add(value);
  return true;
}

function validRect(value: unknown): boolean {
  if (!record(value)) return false;
  return ["x", "y", "width", "height"].every((key) => {
    const coordinate = value[key];
    return (
      typeof coordinate === "number" &&
      Number.isFinite(coordinate) &&
      Math.abs(coordinate) <= 1_000_000
    );
  }) &&
    (value.width as number) >= 0 &&
    (value.height as number) >= 0;
}

/**
 * Checks the FlexLayout portions that can select a component to render. Valid
 * layout JSON is returned untouched so component config (including pinned chart
 * instruments, preferences, ids, and floating-window bounds) survives restore.
 */
export function isWorkspaceLayout(value: unknown): value is IJsonModel {
  if (!record(value) || !record(value.layout)) return false;
  if (value.global !== undefined && !record(value.global)) return false;
  if (value.borders !== undefined && !Array.isArray(value.borders)) return false;
  if (value.subLayouts !== undefined && !record(value.subLayouts)) return false;
  if (value.popouts !== undefined && !record(value.popouts)) return false;

  let count = 0;
  const ids = new Set<string>();
  const check = (node: unknown, depth: number, allowed: readonly string[]): boolean => {
    if (++count > MAX_LAYOUT_NODES || depth > MAX_LAYOUT_DEPTH || !record(node))
      return false;
    if (!allowed.includes(typeof node.type === "string" ? node.type : ""))
      return false;
    if (!validId(node.id, ids)) return false;

    if (node.type === "tab")
      return (
        typeof node.component === "string" &&
        allowedComponents.has(node.component)
      );

    if (!Array.isArray(node.children)) return false;
    const childTypes =
      node.type === "row"
        ? ["row", "tabset"]
        : node.type === "tabset"
          ? ["tab", "tabgroup"]
          : ["tab"];
    return node.children.every((child) => check(child, depth + 1, childTypes));
  };

  if (!check(value.layout, 0, ["row"])) return false;

  const locations = new Set<string>();
  if (
    value.borders &&
    !value.borders.every((border) => {
      if (
        !record(border) ||
        (border.type !== undefined && border.type !== "border") ||
        !allowedBorderLocations.has(border.location as string)
      )
        return false;
      if (locations.has(border.location as string)) return false;
      locations.add(border.location as string);
      if (!validId(border.id, ids)) return false;
      return (
        border.children === undefined ||
        (Array.isArray(border.children) &&
          border.children.every((child) => check(child, 1, ["tab", "tabgroup"])))
      );
    })
  )
    return false;

  const layouts = [value.subLayouts, value.popouts].filter(
    (layouts): layouts is JsonRecord => layouts !== undefined,
  );
  if (layouts.some((layouts) => Object.keys(layouts).length > MAX_SUB_LAYOUTS))
    return false;
  for (const subLayouts of layouts) {
    for (const [id, subLayout] of Object.entries(subLayouts)) {
      if (!id || id.length > 120 || !record(subLayout) || !record(subLayout.layout))
        return false;
      if (
        subLayout.type !== undefined &&
        (typeof subLayout.type !== "string" || !allowedSubLayoutTypes.has(subLayout.type))
      )
        return false;
      if (subLayout.rect !== undefined && !validRect(subLayout.rect)) return false;
      if (!check(subLayout.layout, 0, ["row"])) return false;
    }
  }
  return true;
}

const tab = (
  id: string,
  name: string,
  component: string,
  extra = {},
): IJsonTabNode => ({ type: "tab", id, name, component, ...extra });

export function workspaceLayout(
  preset: WorkspacePreset = "terminal",
): IJsonModel {
  if (["rankings", "charts", "markets", "news"].includes(preset)) {
    const screen = (code: string, name: string) => tab(`capture-${code}`, `[${code}] ${name}`, "capture", { config: { screen: code, linkGroup: "1", sector: "001" } });
    const watch = tab("watch", "[0130] 관심종목", "watch", { config: { linkGroup: "1", watchlistPreferences: { columns: ["name", "last", "change", "changePct", "volume"] } } });
    const chart = tab("chart-1", "[0601] 주식종합차트", "chart", { config: { linkGroup: "1", preferences: { interval: "D" } } });
    const rankingTabs = [screen("0187", "시가총액상위"), screen("0186", "거래대금상위"), screen("0184", "당일거래상위"), screen("0162", "상한가/하한가"), screen("0198", "조회순위"), screen("2797", "업종별 수급")];
    const marketTabs = [screen("0200", "시장종합"), screen("0780", "투자자별 매매동향"), screen("0211", "업종시세")];
    const main = preset === "rankings" ? [...rankingTabs, chart, screen("0602", "업종종합차트"), ...marketTabs, screen("0700", "종합시황뉴스")]
      : preset === "charts" ? [chart, screen("0602", "업종종합차트")]
      : preset === "markets" ? [...marketTabs, screen("2797", "업종별 수급")]
      : [screen("0700", "종합시황뉴스")];
    return {
      global: { tabEnableClose: true, tabEnablePopout: false, tabEnableFloat: true, tabEnableFloatIcon: true, tabSetEnableMaximize: true, tabSetMinWidth: 200, tabSetMinHeight: 180, tabEnableRename: false },
      borders: [],
      layout: { type: "row", children: [
        ...(["rankings", "charts"].includes(preset) ? [{ type: "tabset" as const, id: "watch-set", weight: preset === "rankings" ? 21 : 26, children: [watch] }] : []),
        { type: "tabset", id: "data-set", weight: preset === "rankings" ? 79 : 74, children: main },
      ] },
    };
  }
  if (preset === "capture") {
    const screen = (code: string, name: string) => tab(`capture-${code}`, `[${code}] ${name}`, "capture", { config: { screen: code, linkGroup: "1", sector: "001" } });
    return {
      global: { tabEnableClose: true, tabEnablePopout: false, tabEnableFloat: true, tabEnableFloatIcon: true, tabSetEnableMaximize: true, tabSetMinWidth: 210, tabSetMinHeight: 150, tabEnableRename: false },
      borders: [],
      layout: { type: "row", children: [
        { type: "tabset", id: "watch-set", weight: 22, children: [tab("watch", "[0130] 관심종목", "watch", { config: { linkGroup: "1", watchlistPreferences: { columns: ["name", "last", "change", "changePct", "volume"] } } }), screen("0198", "조회순위"), screen("0187", "시총상위")] },
        { type: "row", weight: 50, children: [
          { type: "tabset", id: "chart-set", weight: 60, children: [tab("chart-1", "[0601] 주식종합차트", "chart", { config: { linkGroup: "1", preferences: { interval: "D" } } }), screen("0602", "업종종합차트"), screen("0211", "업종시세")] },
          { type: "tabset", id: "data-set", weight: 40, children: [screen("0186", "거래대금상위"), screen("0184", "당일거래상위"), screen("0162", "상한가/하한가"), screen("2797", "업종별 기준일 순매수")] },
        ] },
        { type: "tabset", id: "book-set", weight: 28, children: [screen("0200", "시장종합"), screen("0700", "종합시황뉴스"), screen("0780", "투자자별 매매동향"), tab("book", "현재가 · 10호가", "book", { config: { linkGroup: "1" } })] },
      ] },
    };
  }
  const chart = (id: string, weight = 50) => ({
    type: "tabset" as const,
    id: `set-${id}`,
    weight,
    children: [tab(id, `차트 ${id.slice(-1)}`, "chart", { config: { preferences: { interval: ({ "chart-1": "D", "chart-2": "5", "chart-3": "W", "chart-4": "M" } as Record<string,string>)[id] ?? "D" } } })],
  });
  if (preset === "quad") {
    const first = chart("chart-1");
    const second = chart("chart-2");
    first.children.push(tab("watch", "관심종목", "watch", { enableClose: false }));
    second.children.push(tab("book", "현재가 · 10호가", "book", { enableClose: false }));
    return {
      global: { tabEnableClose: true, tabEnablePopout: false, tabEnableFloat: true, tabEnableFloatIcon: true, tabSetEnableMaximize: true, tabSetMinWidth: 280, tabSetMinHeight: 220, tabEnableRename: false },
      borders: [],
      layout: { type: "row", children: [
        { type: "row", weight: 50, children: [first, chart("chart-3")] },
        { type: "row", weight: 50, children: [second, chart("chart-4")] },
      ] },
    };
  }
  const center = {
          type: "row" as const,
          weight: 55,
          children: [
            ...(preset === "dual"
              ? [
                  {
                    type: "row" as const,
                    weight: 72,
                    children: [chart("chart-1"), chart("chart-2")],
                  },
                ]
              : [chart("chart-1", 72)]),
            {
              type: "tabset" as const,
              id: "data-set",
              weight: 28,
              children: [
                tab("history", "시세 데이터", "history"),
                tab("details", "종목 정보", "details"),
                tab("notes", "분석 메모", "notes"),
                tab("alerts", "가격·거래량 알림", "alerts"),
                tab("rankings", "시장 순위", "rankings"),
                tab("investors", "투자자 수급", "investors"),
              ],
            },
          ],
        };
  return {
    global: {
      tabEnableClose: true,
      tabEnablePopout: false,
      tabEnableFloat: true,
      tabEnableFloatIcon: true,
      tabSetEnableMaximize: true,
      tabSetMinWidth: 210,
      tabSetMinHeight: 150,
      tabEnableRename: false,
    },
    borders: [],
    layout: {
      type: "row",
      children: [
        {
          type: "tabset",
          id: "watch-set",
          weight: 23,
          children: [tab("watch", "관심종목", "watch", { enableClose: false })],
        },
        center,
        {
          type: "tabset",
          id: "book-set",
          weight: 22,
          children: [
            tab("book", "현재가 · 10호가", "book", { enableClose: false }),
          ],
        },
      ],
    },
  };
}

export function readWorkspace(value: string | null): IJsonModel | null {
  try {
    if (value && value.length > MAX_WORKSPACE_BYTES) return null;
    const stored = JSON.parse(value || "null");
    if (!record(stored) || stored.version !== 1 || !isWorkspaceLayout(stored.layout))
      return null;
    return stored.layout;
  } catch {
    return null;
  }
}
