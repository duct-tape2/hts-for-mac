import { describe, expect, it, vi } from "vitest";
import { Actions, Model } from "flexlayout-react";
import { workspaceLayout } from "./workspace";
import { createPopoutCloseReconciler, type PopoutRecoveryScheduler } from "./popoutRecovery";

type TimerId = ReturnType<typeof setInterval>;

class FakeScheduler implements PopoutRecoveryScheduler {
  private readonly timers = new Map<TimerId, () => void>();

  setInterval(callback: () => void): TimerId {
    const timer = {} as TimerId;
    this.timers.set(timer, callback);
    return timer;
  }

  clearInterval(timer: TimerId) {
    this.timers.delete(timer);
  }

  run() {
    [...this.timers.values()].forEach((callback) => callback());
  }

  get size() {
    return this.timers.size;
  }
}

function popoutChart() {
  const model = Model.fromJson(workspaceLayout("terminal"));
  const config = { linkGroup: "3", preferences: { interval: "W", volumeRatio: 0.26 } };
  model.doAction(Actions.updateNodeAttributes("chart-1", { config, enablePopout: true }));
  model.doAction(Actions.popoutTab("chart-1", "window"));
  const [layoutId] = Object.keys(model.toJson().subLayouts ?? {});
  return { model, layoutId, config };
}

function onlyTabConfig(model: Model, layoutId: string) {
  const layout = model.toJson().subLayouts?.[layoutId];
  const tabset = layout?.layout.children?.[0] as { children?: Array<{ config?: unknown }> } | undefined;
  return tabset?.children?.[0]?.config;
}

describe("native popout close recovery", () => {
  it("recovers only its closed native popup as the same configured float", () => {
    const { model, layoutId, config } = popoutChart();
    const scheduler = new FakeScheduler();
    const recovery = createPopoutCloseReconciler(model, scheduler);
    const action = vi.spyOn(model, "doAction");
    const popup = { closed: false };

    recovery.track(layoutId, popup);
    scheduler.run();
    expect(model.toJson().subLayouts?.[layoutId]?.type).toBe("window");

    popup.closed = true;
    scheduler.run();

    expect(action).toHaveBeenCalledTimes(1);
    expect(model.toJson().subLayouts?.[layoutId]?.type).toBe("float");
    expect(onlyTabConfig(model, layoutId)).toEqual(config);
    expect(scheduler.size).toBe(0);
    recovery.dispose();
  });

  it("does not reset a float already restored by the normal close callback", () => {
    const { model, layoutId } = popoutChart();
    const scheduler = new FakeScheduler();
    const recovery = createPopoutCloseReconciler(model, scheduler);
    const popup = { closed: true };
    recovery.track(layoutId, popup);
    model.doAction(Actions.closePopout(layoutId));
    const rect = model.toJson().subLayouts?.[layoutId]?.rect;
    const action = vi.spyOn(model, "doAction");

    scheduler.run();

    expect(action).not.toHaveBeenCalled();
    expect(model.toJson().subLayouts?.[layoutId]).toMatchObject({ type: "float", rect });
    expect(scheduler.size).toBe(0);
    recovery.dispose();
  });

  it("cleans its timer and ignores a late popup callback after disposal", () => {
    const { model, layoutId } = popoutChart();
    const scheduler = new FakeScheduler();
    const recovery = createPopoutCloseReconciler(model, scheduler);
    const action = vi.spyOn(model, "doAction");

    recovery.track(layoutId, { closed: true });
    expect(scheduler.size).toBe(1);
    recovery.dispose();
    recovery.track(layoutId, { closed: true });
    scheduler.run();

    expect(action).not.toHaveBeenCalled();
    expect(model.toJson().subLayouts?.[layoutId]?.type).toBe("window");
    expect(scheduler.size).toBe(0);
  });

  it("resumes after StrictMode setup-cleanup-setup before a user opens a popup", () => {
    const { model, layoutId } = popoutChart();
    const scheduler = new FakeScheduler();
    const recovery = createPopoutCloseReconciler(model, scheduler);
    const action = vi.spyOn(model, "doAction");

    recovery.start();
    recovery.dispose();
    recovery.start();
    recovery.track(layoutId, { closed: true });
    scheduler.run();

    expect(action).toHaveBeenCalledTimes(1);
    expect(model.toJson().subLayouts?.[layoutId]?.type).toBe("float");
    recovery.dispose();
  });
});
