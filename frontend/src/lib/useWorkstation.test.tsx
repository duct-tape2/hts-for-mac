import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Actions, Model, TabNode } from "flexlayout-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apple, samsung } from "@/test/fixtures";
import { WORKSPACE_KEY, workspaceLayout } from "./workspace";
import { createWorkstation, readWorkstation, WORKSTATION_KEY } from "./workstation";
import { useWorkstation } from "./useWorkstation";

function chartConfig(layout: ReturnType<Model["toJson"]>) {
  const model = Model.fromJson(layout);
  return (model.getNodeById("chart-1") as TabNode).getConfig() as Record<string, any>;
}

function legacyLayout() {
  const model = Model.fromJson(workspaceLayout("dual"));
  model.doAction(
    Actions.updateNodeAttributes("chart-1", {
      config: {
        instrument: samsung,
        preferences: { interval: "W", displayMode: "line" },
      },
    }),
  );
  model.doAction(Actions.updateNodeAttributes("watch-set", { weight: 31 }));
  return model.toJson();
}

async function ready() {
  const hook = renderHook(() => useWorkstation("fixture"));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  return hook;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("useWorkstation", () => {
  it("opens blank storage in the refined thirteen-screen rankings workspace", async () => {
    const hook = await ready();
    expect(hook.result.current.workspace.preset).toBe("rankings");
    const screens: string[] = [];
    hook.result.current.model.visitNodes((node) => {
      if (node instanceof TabNode) {
        screens.push(node.getComponent() === "capture" ? node.getConfig().screen : node.getComponent() === "watch" ? "0130" : "0601");
      }
    });
    expect(new Set(screens)).toEqual(new Set(["0198", "0187", "0186", "0184", "0162", "0130", "0601", "0602", "0211", "0780", "2797", "0200", "0700"]));
  });

  it("restores an existing saved preset and layout without applying fresh defaults", async () => {
    const baseline = createWorkstation("fixture");
    const saved = readWorkstation(JSON.stringify({
      ...baseline,
      workspaces: [{ ...baseline.workspaces[0], preset: "terminal", layout: workspaceLayout("terminal") }, ...baseline.workspaces.slice(1)],
    }))!;
    const serialized = JSON.stringify(saved);
    localStorage.setItem(WORKSTATION_KEY, serialized);
    const hook = await ready();
    expect(hook.result.current.workspace.preset).toBe("terminal");
    expect(hook.result.current.workspace.layout).toEqual(saved.workspaces[0].layout);
    expect(localStorage.getItem(WORKSTATION_KEY)).toBe(serialized);
  });

  it("migrates the v1 selection, pinned chart, preferences, and layout intact", async () => {
    const migratedLayout = legacyLayout();
    const legacyKey = JSON.stringify({ version: 1, layout: migratedLayout });
    localStorage.setItem(WORKSPACE_KEY, legacyKey);
    localStorage.setItem("kiwoom-hts-selected-v1", JSON.stringify(apple));

    const hook = await ready();
    const first = hook.result.current.workspace;
    const config = chartConfig(first.layout);

    expect(first.instruments["1"]).toMatchObject({ market: "US", stkCd: "AAPL" });
    expect(config.instrument).toMatchObject({ market: "KR", stkCd: "005930" });
    expect(config.preferences).toMatchObject({ interval: "W", displayMode: "line" });
    expect(JSON.stringify(first.layout)).toContain('"weight":31');
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe(legacyKey);

    act(() => hook.result.current.updateCurrent({}));
    const stored = readWorkstation(localStorage.getItem(WORKSTATION_KEY));
    expect(stored?.workspaces[0].instruments["1"]).toMatchObject({ stkCd: "AAPL" });
    expect(chartConfig(stored!.workspaces[0].layout).preferences).toMatchObject({ interval: "W" });
  });

  it("keeps spaces and link groups independent across unmount and remount", async () => {
    const hook = await ready();
    const firstId = hook.result.current.bundle.activeId;
    const secondId = hook.result.current.bundle.workspaces.find((workspace) => workspace.id !== firstId)!.id;

    act(() => hook.result.current.selectInstrument(apple, "2"));
    act(() => hook.result.current.switchTo(secondId));
    act(() => hook.result.current.selectInstrument(samsung, "3"));
    hook.unmount();

    const restored = await ready();
    const first = restored.result.current.bundle.workspaces.find((workspace) => workspace.id === firstId)!;
    const second = restored.result.current.bundle.workspaces.find((workspace) => workspace.id === secondId)!;
    expect(restored.result.current.bundle.activeId).toBe(secondId);
    expect(first.activeGroup).toBe("1");
    expect(first.instruments["1"].stkCd).toBe("005930");
    expect(first.instruments["2"].stkCd).toBe("AAPL");
    expect(second.activeGroup).toBe("1");
    expect(second.instruments["1"].stkCd).toBe("AAPL");
    expect(second.instruments["3"].stkCd).toBe("005930");
  });

  it("persists an active model update and ignores a late callback from the old model", async () => {
    const hook = await ready();
    const firstId = hook.result.current.bundle.activeId;
    const firstModel = hook.result.current.model;

    act(() => {
      firstModel.doAction(Actions.updateNodeAttributes("watch-set", { weight: 39 }));
      hook.result.current.saveModel(firstModel, firstId);
    });
    let stored = readWorkstation(localStorage.getItem(WORKSTATION_KEY))!;
    expect(JSON.stringify(stored.workspaces.find((workspace) => workspace.id === firstId)!.layout)).toContain('"weight":39');

    const secondId = hook.result.current.bundle.workspaces.find((workspace) => workspace.id !== firstId)!.id;
    act(() => hook.result.current.switchTo(secondId));
    const beforeLateCallback = readWorkstation(localStorage.getItem(WORKSTATION_KEY))!;
    const firstBefore = JSON.stringify(beforeLateCallback.workspaces.find((workspace) => workspace.id === firstId)!.layout);
    act(() => {
      firstModel.doAction(Actions.updateNodeAttributes("watch-set", { weight: 99 }));
      hook.result.current.saveModel(firstModel, firstId);
    });
    stored = readWorkstation(localStorage.getItem(WORKSTATION_KEY))!;
    expect(JSON.stringify(stored.workspaces.find((workspace) => workspace.id === firstId)!.layout)).toBe(firstBefore);
  });

  it("persists a renamed active workspace through remount", async () => {
    const hook = await ready();
    act(() => hook.result.current.rename("  오전 관찰  "));
    expect(hook.result.current.workspace.name).toBe("오전 관찰");
    hook.unmount();

    const restored = await ready();
    expect(restored.result.current.workspace.name).toBe("오전 관찰");
  });

  it("keeps in-memory changes and exposes a note when storage writes fail", async () => {
    const hook = await ready();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    act(() => hook.result.current.rename("저장 실패에도 유지"));
    expect(hook.result.current.workspace.name).toBe("저장 실패에도 유지");
    expect(hook.result.current.note).toContain("저장 실패");
  });

  it("rejects an invalid model without poisoning later valid changes", async () => {
    const hook = await ready();
    act(() => hook.result.current.rename("유효한 저장본"));
    const validModel = hook.result.current.model;
    act(() => {
      validModel.doAction(Actions.updateNodeAttributes("chart-1", { component: "unknown" }));
      hook.result.current.saveModel(validModel, hook.result.current.workspace.id);
    });
    expect(hook.result.current.model).not.toBe(validModel);
    expect((hook.result.current.model.getNodeById("chart-1") as TabNode).getComponent()).toBe("chart");
    act(() => hook.result.current.rename("다음 변경도 저장"));
    expect(readWorkstation(localStorage.getItem(WORKSTATION_KEY))?.workspaces[0].name).toBe("다음 변경도 저장");
  });
});


describe("preset histories", () => {
  it("restores a resized user layout after switching to a roomy screen preset", async () => {
    const hook = await ready();
    act(() => hook.result.current.setPreset("terminal"));
    act(() => {
      hook.result.current.model.doAction(Actions.updateNodeAttributes("watch-set", { weight: 37 }));
      hook.result.current.saveModel(hook.result.current.model, hook.result.current.workspace.id);
    });
    act(() => hook.result.current.setPreset("rankings"));
    expect(hook.result.current.workspace.preset).toBe("rankings");
    act(() => hook.result.current.setPreset("terminal"));
    expect(JSON.stringify(hook.result.current.model.toJson())).toContain('"weight":37');
    hook.unmount();
    const restored = await ready();
    act(() => restored.result.current.setPreset("rankings"));
    expect(restored.result.current.model.getNodeById("capture-0187")).toBeDefined();
    act(() => restored.result.current.setPreset("terminal"));
    expect(JSON.stringify(restored.result.current.model.toJson())).toContain('"weight":37');
  });
});


it("keeps the active model and state intact when imported layout persistence fails", async () => {
  const hook = await ready();
  const before = hook.result.current.bundle;
  const beforeModel = hook.result.current.model;
  const imported = structuredClone(before);
  imported.workspaces[0].name = "새 작업공간";
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(() => act(() => hook.result.current.restoreBundle(imported))).toThrow("기존 배치를 유지");
  expect(hook.result.current.bundle).toBe(before);
  expect(hook.result.current.model).toBe(beforeModel);
});
