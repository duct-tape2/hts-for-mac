import { describe, expect, it } from "vitest";
import { alertEngineLockName, createAlertEngineOwnership, withAlertStorageLock, type AlertLockManager, type AlertOwnershipState } from "@/components/alertOwnership";

type Waiting = { callback: (lock: unknown) => unknown; resolve: (value: unknown) => void; reject: (reason?: unknown) => void; signal?: AbortSignal };

class FakeLocks implements AlertLockManager {
  private active = new Set<string>();
  private queues = new Map<string, Waiting[]>();

  request<T>(name: string, options: { mode: "exclusive"; signal?: AbortSignal }, callback: (lock: unknown) => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiting: Waiting = { callback, resolve: resolve as (value: unknown) => void, reject, signal: options.signal };
      const queue = this.queues.get(name) ?? [];
      this.queues.set(name, queue);
      queue.push(waiting);
      options.signal?.addEventListener("abort", () => {
        const index = queue.indexOf(waiting);
        if (index >= 0) {
          queue.splice(index, 1);
          reject(new DOMException("Aborted", "AbortError"));
        }
      }, { once: true });
      this.pump(name);
    });
  }

  private pump(name: string) {
    if (this.active.has(name)) return;
    const queue = this.queues.get(name) ?? [];
    let next: Waiting | undefined;
    while (queue.length && !next) {
      const candidate = queue.shift();
      if (candidate && !candidate.signal?.aborted) next = candidate;
    }
    if (!next) return;
    this.active.add(name);
    Promise.resolve(next.callback({})).then(next.resolve, next.reject).finally(() => {
      this.active.delete(name);
      this.pump(name);
    });
  }
}

class FakeVisibility {
  visibilityState: DocumentVisibilityState;
  private readonly listeners = new Set<EventListener>();

  constructor(initial: DocumentVisibilityState = "visible") {
    this.visibilityState = initial;
  }

  addEventListener(type: "visibilitychange", listener: EventListener) {
    if (type === "visibilitychange") this.listeners.add(listener);
  }

  removeEventListener(type: "visibilitychange", listener: EventListener) {
    if (type === "visibilitychange") this.listeners.delete(listener);
  }

  setVisibility(next: DocumentVisibilityState) {
    this.visibilityState = next;
    this.listeners.forEach((listener) => listener(new Event("visibilitychange")));
  }
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("alert ownership", () => {
  it("holds one origin/environment engine lock, then releases it for the next owner", async () => {
    const locks = new FakeLocks();
    const first: string[] = [], second: string[] = [];
    const one = createAlertEngineOwnership({ environment: "real", origin: "https://localhost:3010", locks, onState: (state) => first.push(state) });
    const two = createAlertEngineOwnership({ environment: "real", origin: "https://localhost:3010", locks, onState: (state) => second.push(state) });
    one.start(); one.start(); two.start();
    await settle();

    expect(first).toEqual(["waiting", "owner"]);
    expect(second).toEqual(["waiting"]);
    expect(alertEngineLockName("real", "https://localhost:3010")).toContain(":engine:https://localhost:3010:real");

    one.release();
    await settle();
    expect(second).toEqual(["waiting", "owner"]);
    two.release();
  });

  it("cancels a waiting owner cleanly and serializes the separate storage lock", async () => {
    const locks = new FakeLocks();
    const first: string[] = [], canceled: string[] = [];
    const one = createAlertEngineOwnership({ environment: "fixture", origin: "https://localhost:3010", locks, onState: (state) => first.push(state) });
    const two = createAlertEngineOwnership({ environment: "fixture", origin: "https://localhost:3010", locks, onState: (state) => canceled.push(state) });
    one.start(); two.start();
    await settle();
    two.release();
    one.release();
    await settle();
    expect(first).toEqual(["waiting", "owner"]);
    expect(canceled).toEqual(["waiting"]);

    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstMutation = withAlertStorageLock(async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first-end");
      return 1;
    }, { locks, origin: "https://localhost:3010" });
    const secondMutation = withAlertStorageLock(() => { order.push("second"); return 2; }, { locks, origin: "https://localhost:3010" });
    await settle();
    expect(order).toEqual(["first-start"]);
    releaseFirst?.();
    await expect(firstMutation).resolves.toMatchObject({ atomic: true, value: 1 });
    await expect(secondMutation).resolves.toMatchObject({ atomic: true, value: 2 });
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("releases a hidden owner so a visible window monitors, without duplicate reacquisition", async () => {
    const locks = new FakeLocks();
    const firstWindow = new FakeVisibility();
    const secondWindow = new FakeVisibility();
    const first: string[] = [], second: string[] = [];
    const monitoring = new Set<string>();
    const track = (id: string, states: string[]) => (state: AlertOwnershipState) => {
      states.push(state);
      if (state === "owner") monitoring.add(id);
      else monitoring.delete(id);
    };
    const one = createAlertEngineOwnership({ environment: "real", origin: "https://localhost:3010", locks, visibility: firstWindow, onState: track("one", first) });
    const two = createAlertEngineOwnership({ environment: "real", origin: "https://localhost:3010", locks, visibility: secondWindow, onState: track("two", second) });
    one.start(); two.start();
    await settle();
    expect(monitoring).toEqual(new Set(["one"]));

    firstWindow.setVisibility("hidden");
    await settle();
    expect(first).toEqual(["waiting", "owner", "waiting"]);
    expect(second).toEqual(["waiting", "owner"]);
    expect(monitoring).toEqual(new Set(["two"]));

    firstWindow.setVisibility("visible");
    await settle();
    expect(monitoring).toEqual(new Set(["two"]));
    expect(first.filter((state) => state === "owner")).toHaveLength(1);

    two.release();
    // Cleanup stops the owning service; it deliberately does not set React
    // state after an unmount, so mirror the released service here.
    monitoring.delete("two");
    await settle();
    expect(monitoring).toEqual(new Set(["one"]));
    expect(first.filter((state) => state === "owner")).toHaveLength(2);
    one.release();
    monitoring.delete("one");
    await settle();
    expect(monitoring).toEqual(new Set());
  });

  it("does not let a StrictMode-cleaned waiting request acquire after its replacement starts", async () => {
    const locks = new FakeLocks();
    const holder = createAlertEngineOwnership({ environment: "fixture", origin: "https://localhost:3010", locks, onState: () => undefined });
    const staleStates: string[] = [], replacementStates: string[] = [];
    const stale = createAlertEngineOwnership({ environment: "fixture", origin: "https://localhost:3010", locks, onState: (state) => staleStates.push(state) });
    holder.start(); stale.start();
    await settle();
    stale.release();
    const replacement = createAlertEngineOwnership({ environment: "fixture", origin: "https://localhost:3010", locks, onState: (state) => replacementStates.push(state) });
    replacement.start();
    holder.release();
    await settle();

    expect(staleStates).toEqual(["waiting"]);
    expect(replacementStates).toEqual(["waiting", "owner"]);
    replacement.release();
  });
});
