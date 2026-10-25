export type AuthEnvironment = "real" | "demo" | "fixture";
export type AuthStorage = "keychain" | "none" | "unavailable";
export type AuthStatusKind = "ready" | "needs_credentials" | "refreshing" | "retrying" | "error";

export type AuthStatus = {
  environment: AuthEnvironment;
  stored: boolean;
  canSaveLauncher?: boolean;
  storage: AuthStorage;
  status: AuthStatusKind;
  registeredExpiresOn: string | null;
  remindOn: string | null;
  renewalDue: boolean;
  registrationExpired: boolean;
  tokenExpiresAt: string | null;
  lastRefreshAt: string | null;
  nextRetryAt: string | null;
  message: string;
  setupToken: string;
};

export type CredentialInput = {
  appKey: string;
  appSecret: string;
  registeredExpiresOn: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ENVIRONMENTS = ["real", "demo", "fixture"] as const;
const STORAGES = ["keychain", "none", "unavailable"] as const;
const STATUSES = ["ready", "needs_credentials", "refreshing", "retrying", "error"] as const;

export class CredentialApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "CredentialApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function nullableDate(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (!isDate(value)) throw new CredentialApiError(`${label} 형식이 올바르지 않습니다.`);
  return value;
}

function nullableIso(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new CredentialApiError(`${label} 형식이 올바르지 않습니다.`);
  return value;
}

function requiredMember<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new CredentialApiError(`${label} 형식이 올바르지 않습니다.`);
  return value as T[number];
}

/** Validate only the safe, documented auth-status shape returned by the backend. */
export function parseAuthStatus(value: unknown): AuthStatus {
  if (!isRecord(value)) throw new CredentialApiError("인증 상태 응답을 확인할 수 없습니다.");
  if (
    !ENVIRONMENTS.includes(value.environment as AuthEnvironment) ||
    typeof value.stored !== "boolean" ||
    !STORAGES.includes(value.storage as AuthStorage) ||
    !STATUSES.includes(value.status as AuthStatusKind) ||
    typeof value.renewalDue !== "boolean" ||
    typeof value.registrationExpired !== "boolean" ||
    typeof value.message !== "string" ||
    typeof value.setupToken !== "string" ||
    !value.setupToken
  ) throw new CredentialApiError("인증 상태 응답을 확인할 수 없습니다.");

  const registeredExpiresOn = nullableDate(value.registeredExpiresOn, "registeredExpiresOn");
  const remindOn = nullableDate(value.remindOn, "remindOn");
  if ((registeredExpiresOn === null && (remindOn !== null || value.renewalDue || value.registrationExpired)) || (value.stored && registeredExpiresOn === null)) {
    throw new CredentialApiError("인증 상태 응답을 확인할 수 없습니다.");
  }

  return {
    environment: requiredMember(value.environment, ENVIRONMENTS, "environment"),
    stored: value.stored,
    ...(typeof value.canSaveLauncher === "boolean" ? {canSaveLauncher: value.canSaveLauncher} : {}),
    storage: requiredMember(value.storage, STORAGES, "storage"),
    status: requiredMember(value.status, STATUSES, "status"),
    registeredExpiresOn,
    remindOn,
    renewalDue: value.renewalDue,
    registrationExpired: value.registrationExpired,
    tokenExpiresAt: nullableIso(value.tokenExpiresAt, "tokenExpiresAt"),
    lastRefreshAt: nullableIso(value.lastRefreshAt, "lastRefreshAt"),
    nextRetryAt: nullableIso(value.nextRetryAt, "nextRetryAt"),
    message: value.message,
    setupToken: value.setupToken,
  };
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

async function requestAuth(path: string, init: RequestInit, safeFailure: string): Promise<AuthStatus> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new CredentialApiError(safeFailure);
  }
  if (!response.ok) throw new CredentialApiError(safeFailure, response.status);
  try {
    return parseAuthStatus(await response.json());
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof CredentialApiError && error.message === safeFailure) throw error;
    throw new CredentialApiError(safeFailure);
  }
}

export function getAuthStatus(signal?: AbortSignal) {
  return requestAuth("/api/auth/status", { method: "GET", signal }, "인증 상태를 확인하지 못했습니다. 잠시 후 다시 시도하세요.");
}

export function saveAuthCredentials(setupToken: string, input: CredentialInput, signal?: AbortSignal) {
  return requestAuth(
    "/api/auth/credentials",
    {
      method: "POST",
      signal,
      headers: { "X-HTS-Setup": setupToken },
      body: JSON.stringify(input),
    },
    "인증 정보를 저장하지 못했습니다. 입력값과 연결 상태를 확인하세요.",
  );
}

export function saveLauncherCredentials(setupToken: string, registeredExpiresOn: string) {
  return requestAuth("/api/auth/credentials/from-launcher", {
    method: "POST", headers: { "X-HTS-Setup": setupToken },
    body: JSON.stringify({ registeredExpiresOn }),
  }, "현재 연결 키를 저장하지 못했습니다. 연결 상태와 키체인을 확인하세요.");
}

export function isCredentialAbortError(error: unknown) {
  return isAbortError(error);
}
