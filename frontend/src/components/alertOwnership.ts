import type { Environment } from "@/lib/types";

export type AlertOwnershipState = "owner" | "waiting" | "unsupported" | "unavailable";

export type AlertLockManager = {
  request<T>(name: string, options: { mode: "exclusive"; signal?: AbortSignal }, callback: (lock: unknown) => T | Promise<T>): Promise<T>;
};

type OwnershipOptions = {
  environment: Environment;
  onState: (state: AlertOwnershipState) => void;
  locks?: AlertLockManager | null;
  origin?: string;
  /** Injectable only to keep separate browser windows independently testable. */
  visibility?: VisibilityTarget | null;
};

type StorageLockOptions = {
  locks?: AlertLockManager | null;
  origin?: string;
  signal?: AbortSignal;
};

type VisibilityTarget = {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: EventListener): void;
  removeEventListener(type: "visibilitychange", listener: EventListener): void;
};

const PREFIX = "kiwoom-readonly-market-alerts-v1";

function currentLocks(): AlertLockManager | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: AlertLockManager }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

function currentOrigin() {
  return typeof location === "undefined" ? "server" : location.origin || "local";
}

function currentVisibility(): VisibilityTarget | null {
  return typeof document === "undefined" ? null : document;
}

export function alertEngineLockName(environment: Environment, origin = currentOrigin()) {
  return `${PREFIX}:engine:${origin}:${environment}`;
}

export function alertStorageLockName(origin = currentOrigin()) {
  return `${PREFIX}:storage:${origin}`;
}

/** Hold one per-origin/environment engine lock until the caller releases it. */
export function createAlertEngineOwnership({ environment, onState, locks = currentLocks(), origin = currentOrigin(), visibility = currentVisibility() }: OwnershipOptions) {
  let stopped = false;
  let started = false;
  let owns = false;
  let releaseHold: (() => void) | null = null;
  let waiting: AbortController | null = null;
  let ownerGeneration: number | null = null;
  let generation = 0;

  function notify(state: AlertOwnershipState) {
    if (!stopped) onState(state);
  }

  function hidden() {
    return visibility?.visibilityState === "hidden";
  }

  function abandonCurrentOwnership() {
    generation += 1;
    if (waiting) {
      waiting.abort();
      waiting = null;
    }
    if (!owns) return;
    owns = false;
    ownerGeneration = null;
    const release = releaseHold;
    releaseHold = null;
    release?.();
    notify("waiting");
  }

  function requestOwnership() {
    if (stopped || !started || hidden() || owns || waiting) return;
    if (!locks) {
      notify("unsupported");
      return;
    }
    const controller = new AbortController();
    const requestGeneration = ++generation;
    waiting = controller;
    notify("waiting");
    void locks.request(alertEngineLockName(environment, origin), { mode: "exclusive", signal: controller.signal }, async () => {
      if (stopped || !started || hidden() || controller.signal.aborted || requestGeneration !== generation) return;
      if (waiting === controller) waiting = null;
      owns = true;
      ownerGeneration = requestGeneration;
      notify("owner");
      await new Promise<void>((resolve) => { releaseHold = resolve; });
      if (ownerGeneration === requestGeneration) {
        releaseHold = null;
        ownerGeneration = null;
        owns = false;
      }
    }).catch((error: unknown) => {
      if (waiting === controller) waiting = null;
      if (!stopped && started && requestGeneration === generation && !hidden() && !(error instanceof DOMException && error.name === "AbortError")) notify("unavailable");
    });
  }

  const onVisibilityChange: EventListener = () => {
    if (hidden()) abandonCurrentOwnership();
    else requestOwnership();
  };

  function start() {
    if (stopped || started) return;
    started = true;
    visibility?.addEventListener("visibilitychange", onVisibilityChange);
    requestOwnership();
  }

  function release() {
    if (stopped) return;
    stopped = true;
    visibility?.removeEventListener("visibilitychange", onVisibilityChange);
    abandonCurrentOwnership();
  }

  return { start, release };
}

/** Serialize storage read-modify-write separately from the lifetime engine lock. */
export async function withAlertStorageLock<T>(task: () => T | Promise<T>, { locks = currentLocks(), origin = currentOrigin(), signal }: StorageLockOptions = {}) {
  if (!locks) return { atomic: false, value: await task() };
  const value = await locks.request(alertStorageLockName(origin), { mode: "exclusive", signal }, () => task());
  return { atomic: true, value };
}
