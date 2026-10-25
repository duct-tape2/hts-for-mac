"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  CredentialApiError,
  getAuthStatus,
  isCredentialAbortError,
  saveAuthCredentials,
  saveLauncherCredentials,
  type AuthStatus,
  type AuthStatusKind,
} from "@/lib/credentials";
import "./credentialSettings.css";

const STATUS_POLL_MS = 60_000;

export type CredentialSettingsProps = {
  environment: "real" | "demo" | "fixture";
  onConnected?: (status: AuthStatus) => void;
};

type StatusRequest = { controller: AbortController; promise: Promise<AuthStatus | null>; generation: number };

const STATUS_LABEL: Record<AuthStatusKind, string> = {
  ready: "연결 준비됨",
  needs_credentials: "API 키 필요",
  refreshing: "토큰 갱신 중",
  retrying: "재시도 대기",
  error: "연결 오류",
};

function formatKst(value: string | null) {
  if (!value) return "확인 중";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "확인 중";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDate(value: string | null) {
  return value ?? "직접 입력 필요";
}

function reminder(status: AuthStatus | null) {
  if (!status) return "";
  if (status.registrationExpired) return `API 키 등록 만료일이 지났습니다. 공식 포털에서 새 AppKey/AppSecret을 발급하고 만료일을 확인하세요.`;
  if (status.renewalDue) return `API 키 등록 만료일이 가까워졌습니다${status.remindOn ? ` · 안내일 ${status.remindOn}` : ""}. 공식 포털에서 새 키를 준비하세요.`;
  return "";
}

export function CredentialSettings({ environment, onConnected }: CredentialSettingsProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const appKeyRef = useRef<HTMLInputElement>(null);
  const appSecretRef = useRef<HTMLInputElement>(null);
  const expiryRef = useRef<HTMLInputElement>(null);
  const expiryDirtyRef = useRef(false);
  const setupTokenRef = useRef("");
  const requestRef = useRef<StatusRequest | null>(null);
  const statusGenerationRef = useRef(0);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const wasOpenRef = useRef(false);
  const autoSetupShownRef = useRef(false);
  const titleId = useId();

  const syncStatusExpiry = useCallback((next: AuthStatus, force = false) => {
    if (next.registeredExpiresOn && expiryRef.current && (force || !expiryDirtyRef.current)) expiryRef.current.value = next.registeredExpiresOn;
  }, []);

  const cancelStatusRequest = useCallback(() => {
    statusGenerationRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current = null;
    if (mountedRef.current) setStatusLoading(false);
  }, []);

  const loadStatus = useCallback(async (force = false) => {
    if (savingRef.current && !force) return null;
    if (requestRef.current) return requestRef.current.promise;
    setStatusLoading(true);
    const controller = new AbortController();
    const generation = statusGenerationRef.current;
    const promise = getAuthStatus(controller.signal)
      .then((next) => {
        if (!mountedRef.current || (savingRef.current && !force) || generation !== statusGenerationRef.current) return null;
        setupTokenRef.current = next.setupToken;
        setStatus(next);
        syncStatusExpiry(next);
        return next;
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current || isCredentialAbortError(cause)) return null;
        setError(cause instanceof CredentialApiError ? cause.message : "인증 상태를 확인하지 못했습니다. 잠시 후 다시 시도하세요.");
        return null;
      })
      .finally(() => {
        if (requestRef.current?.promise === promise) {
          requestRef.current = null;
          if (mountedRef.current) setStatusLoading(false);
        }
      });
    requestRef.current = { controller, promise, generation };
    return promise;
  }, [syncStatusExpiry]);

  useEffect(() => {
    mountedRef.current = true;
    setupTokenRef.current = "";
    setStatus(null);
    setError("");
    void loadStatus();
    const interval = window.setInterval(() => void loadStatus(), STATUS_POLL_MS);
    const onFocus = () => void loadStatus();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void loadStatus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      cancelStatusRequest();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cancelStatusRequest, environment, loadStatus]);

  useEffect(() => {
    autoSetupShownRef.current = false;
  }, [environment]);

  useEffect(() => {
    if (environment === "fixture" || autoSetupShownRef.current || !status || status.stored || status.status !== "needs_credentials") return;
    autoSetupShownRef.current = true;
    setOpen(true);
  }, [environment, status]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open) {
      if (dialog && !dialog.open) dialog.showModal();
      dialog?.focus();
      appKeyRef.current?.focus();
    } else if (wasOpenRef.current) {
      if (dialog?.open) dialog.close();
      triggerRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  function scrubForm() {
    if (appKeyRef.current) appKeyRef.current.value = "";
    if (appSecretRef.current) appSecretRef.current.value = "";
    formRef.current?.reset();
    expiryDirtyRef.current = false;
    if (status?.registeredExpiresOn && expiryRef.current) expiryRef.current.value = status.registeredExpiresOn;
  }

  function close() {
    if (savingRef.current) {
      setError("저장 중입니다. 작업이 끝날 때까지 창을 닫을 수 없습니다.");
      return;
    }
    scrubForm();
    setError("");
    setOpen(false);
  }

  function openSettings() {
    if (savingRef.current) return;
    setError("");
    setOpen(true);
    if (status?.registeredExpiresOn && expiryRef.current) {
      expiryDirtyRef.current = false;
      expiryRef.current.value = status.registeredExpiresOn;
    }
    if (!status && !requestRef.current) void loadStatus();
  }

  async function submit(event: FormEvent<HTMLFormElement> | null) {
    event?.preventDefault();
    const fromLauncher = event === null;
    if (fromLauncher && !status?.canSaveLauncher) return;
    if (environment === "fixture") {
      setError("테스트 데이터 환경에서는 API 키를 등록하지 않습니다. 실환경 또는 모의 서버로 전환하세요.");
      return;
    }
    const form = event?.currentTarget ?? formRef.current;
    if (!form) return;
    const data = new FormData(form);
    const appKey = fromLauncher ? "" : String(data.get("appKey") ?? "");
    const appSecret = fromLauncher ? "" : String(data.get("appSecret") ?? "");
    const registeredExpiresOn = String(data.get("registeredExpiresOn") ?? "");
    if ((!fromLauncher && (!appKey.trim() || !appSecret.trim())) || !/^\d{4}-\d{2}-\d{2}$/.test(registeredExpiresOn)) {
      setError("AppKey, AppSecret, 등록 만료일을 모두 입력하세요.");
      return;
    }
    if (!setupTokenRef.current) {
      setError("설정 권한을 확인하지 못했습니다. 상태를 다시 확인한 뒤 시도하세요.");
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
    cancelStatusRequest();
    setSaving(true);
    setError("");
    try {
      const next = fromLauncher
        ? await saveLauncherCredentials(setupTokenRef.current, registeredExpiresOn)
        : await saveAuthCredentials(setupTokenRef.current, { appKey, appSecret, registeredExpiresOn });
      if (!mountedRef.current) return;
      setupTokenRef.current = next.setupToken;
      setStatus(next);
      scrubForm();
      syncStatusExpiry(next, true);
      setOpen(false);
      onConnected?.(next);
    } catch (cause: unknown) {
      if (!mountedRef.current || isCredentialAbortError(cause)) return;
      if (cause instanceof CredentialApiError && cause.status === 403) {
        const fresh = await loadStatus(true);
        setError(fresh ? "설정 권한이 만료되었습니다. 새 권한을 받았습니다. 비밀키를 다시 제출하세요." : "설정 권한이 만료되었습니다. 상태를 새로 확인하지 못했습니다. 잠시 후 다시 시도하세요.");
      } else {
        setError(cause instanceof CredentialApiError ? cause.message : "인증 정보를 저장하지 못했습니다. 잠시 후 다시 시도하세요.");
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  const statusKind = status?.status ?? (statusLoading ? "refreshing" : "error");
  const statusText = environment === "fixture" ? "테스트 · API 미사용"
    : status?.status === "ready" ? status.registrationExpired ? "연결 · 등록 갱신 필요"
      : status.storage === "unavailable" ? "연결 · 키체인 확인"
      : status.stored && status.storage === "keychain" ? "연결 · 자동 갱신" : "임시 토큰 · 키 미저장"
    : status ? STATUS_LABEL[status.status] : statusLoading ? "상태 확인 중" : "확인 필요";
  const reminderText = reminder(status);
  const fixtureDisabled = environment === "fixture";

  return (
    <div className="credential-settings">
      <span className="credential-settings__badge" data-status={statusKind} aria-label={`API 연결 상태: ${statusText}`}>
        API · {statusText}
      </span>
      <button ref={triggerRef} type="button" className="hts-btn" onClick={openSettings} aria-haspopup="dialog">
        API 연결 설정
      </button>
      {reminderText && <span className="credential-settings__reminder credential-settings__reminder--compact" role="alert">갱신 안내 · {status?.registeredExpiresOn}</span>}
      <dialog
        ref={dialogRef}
        className="credential-settings__dialog"
        aria-labelledby={titleId}
        aria-modal="true"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      >
        <div className="credential-settings__header">
          <h2 id={titleId}>API 연결 설정</h2>
          <button type="button" className="hts-btn credential-settings__close" onClick={close} disabled={saving} aria-label="API 연결 설정 닫기">닫기</button>
        </div>
        <div className="credential-settings__body">
          {statusLoading && <p className="credential-settings__status" role="status">인증 상태를 확인하는 중…</p>}
          {status && (
            <div className="credential-settings__status" role="status">
              <div><b>{statusText}</b> · {status.storage === "keychain" ? "이 Mac의 키체인" : status.storage === "none" ? "저장된 키 없음" : "키체인 사용 불가"}</div>
              <div>API 키 등록 만료일 (직접 등록): {formatDate(status.registeredExpiresOn)}</div>
              <div>다음 갱신 안내일: {status.remindOn ?? "등록 후 안내합니다."}</div>
              <div>접속 토큰 만료 (KST): {formatKst(status.tokenExpiresAt)} · {status.stored && status.storage === "keychain" ? status.registrationExpired || status.status === "needs_credentials" ? "자동 갱신을 위해 키 확인 필요" : status.status === "error" || status.status === "retrying" ? "저장된 키로 자동 재시도" : "자동 갱신 사용" : "자동 갱신을 위해 키 등록 필요"}</div>
              {status.message && <div>{status.message}</div>}
            </div>
          )}
          {reminderText && <p className="credential-settings__reminder" role="alert">{reminderText}</p>}
          {fixtureDisabled && <p className="credential-settings__hint" role="note">테스트 데이터 환경에서는 실제 브로커 호출과 API 키 등록을 하지 않습니다. 실환경 또는 모의 서버로 전환한 뒤 입력하세요.</p>}
          {status && !status.registeredExpiresOn && !fixtureDisabled && <p className="credential-settings__hint" role="note">처음 설정하는 경우 키움 포털에 표시된 API 키 등록 만료일을 직접 입력하세요. 임의의 날짜는 채우지 않습니다.</p>}
          {error && <p className="credential-settings__error" role="alert">{error}</p>}
          {status?.canSaveLauncher && !fixtureDisabled && <p className="credential-settings__hint">
            터미널에서 입력한 키가 현재 백엔드에 있습니다. 아래 만료일을 확인하면 다시 입력하지 않고 저장할 수 있습니다.
            <button type="button" className="hts-btn" disabled={saving} onClick={() => void submit(null)}>현재 연결 키를 키체인에 저장</button>
          </p>}
          <form ref={formRef} onSubmit={submit} noValidate>
            <div className="credential-settings__fields">
              <label className="credential-settings__field" htmlFor={`${titleId}-app-key`}>AppKey
                <input ref={appKeyRef} id={`${titleId}-app-key`} name="appKey" type="password" autoComplete="off" spellCheck={false} disabled={fixtureDisabled || saving} aria-describedby={`${titleId}-privacy`} />
              </label>
              <label className="credential-settings__field" htmlFor={`${titleId}-app-secret`}>AppSecret
                <input ref={appSecretRef} id={`${titleId}-app-secret`} name="appSecret" type="password" autoComplete="off" spellCheck={false} disabled={fixtureDisabled || saving} aria-describedby={`${titleId}-privacy`} />
              </label>
              <label className="credential-settings__field" htmlFor={`${titleId}-registered-expires`}>API 키 등록 만료일 (직접 등록)
                <input ref={expiryRef} id={`${titleId}-registered-expires`} name="registeredExpiresOn" type="date" defaultValue="" disabled={fixtureDisabled || saving} onChange={() => { expiryDirtyRef.current = true; }} required />
              </label>
            </div>
            <p id={`${titleId}-privacy`} className="credential-settings__hint">비밀값은 이 화면의 메모리에만 머물며, 저장 성공 후 즉시 비웁니다. GitHub나 브라우저 저장소에 기록하지 않습니다.</p>
            <div className="credential-settings__footer">
              <span className="credential-settings__footer-note">저장 위치: 이 Mac의 키체인</span>
              <button type="button" className="hts-btn" onClick={close} disabled={saving}>취소</button>
              <button type="submit" className="hts-btn" disabled={fixtureDisabled || saving}>{saving ? "저장 중…" : "안전하게 저장"}</button>
            </div>
          </form>
          <details className="credential-settings__guide" open>
            <summary>갱신 안내</summary>
            <ol>
              <li><a href="https://openapi.kiwoom.com/mgmt/VOpenApiRegView" target="_blank" rel="noopener noreferrer">키움 API 관리·갱신 열기</a>에서 API 사용신청 → 계좌 AppKey 관리로 이동합니다. 모의 환경은 모의 탭을 사용하세요.</li>
              <li>해당 계좌를 갱신하고 새 AppKey/AppSecret과 포털에 표시된 새 등록 만료일을 확인합니다.</li>
              <li>이 화면의 두 필드와 만료일을 입력한 뒤 저장합니다.</li>
            </ol>
            <p>다른 네트워크에서 사용하면 키움에 허용 IP도 등록하세요.</p>
          </details>
        </div>
      </dialog>
    </div>
  );
}

export { formatKst };
