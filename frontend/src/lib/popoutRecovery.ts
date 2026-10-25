import { Actions, type Model } from "flexlayout-react";

type NativePopoutWindow = Pick<Window, "closed">;
type TimerId = ReturnType<typeof setInterval>;

export type PopoutRecoveryScheduler = {
  setInterval: (callback: () => void, intervalMs: number) => TimerId;
  clearInterval: (timer: TimerId) => void;
};

export type PopoutRecovery = {
  start: () => void;
  track: (layoutId: string, popup: NativePopoutWindow) => void;
  untrack: (layoutId: string) => void;
  reconcile: () => void;
  dispose: () => void;
};

const POLL_INTERVAL_MS = 1_000;

function nativeWindowType(model: Pick<Model, "toJson">, layoutId: string) {
  const json = model.toJson();
  return json.subLayouts?.[layoutId]?.type ?? json.popouts?.[layoutId]?.type;
}

/**
 * Native popout windows normally notify FlexLayout during beforeunload. Some
 * hosts close a popup without delivering that event to its opener, leaving the
 * model pointing at an already-closed native window. Track only windows this
 * layout opened and convert those orphaned windows to FlexLayout's existing
 * in-page float representation.
 */
export function createPopoutCloseReconciler(
  model: Pick<Model, "toJson" | "doAction">,
  scheduler: PopoutRecoveryScheduler = globalThis,
): PopoutRecovery {
  const popouts = new Map<string, NativePopoutWindow>();
  let timer: TimerId | undefined;
  let disposed = false;

  const stopWhenIdle = () => {
    if (timer === undefined || popouts.size > 0) return;
    scheduler.clearInterval(timer);
    timer = undefined;
  };

  const reconcile = () => {
    if (disposed) return;
    for (const [layoutId, popup] of popouts) {
      if (!popup.closed) continue;
      popouts.delete(layoutId);
      // A normal beforeunload may have already changed this to a float while
      // the interval was queued. Avoid resetting its restored position.
      if (nativeWindowType(model, layoutId) === "window") {
        model.doAction(Actions.closePopout(layoutId));
      }
    }
    stopWhenIdle();
  };

  return {
    start() {
      disposed = false;
    },
    track(layoutId, popup) {
      if (disposed) return;
      popouts.set(layoutId, popup);
      if (timer === undefined) timer = scheduler.setInterval(reconcile, POLL_INTERVAL_MS);
    },
    untrack(layoutId) {
      popouts.delete(layoutId);
      stopWhenIdle();
    },
    reconcile,
    dispose() {
      if (disposed) return;
      disposed = true;
      popouts.clear();
      if (timer !== undefined) scheduler.clearInterval(timer);
      timer = undefined;
    },
  };
}
