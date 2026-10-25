"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CredentialApiError, getAuthStatus, isCredentialAbortError, type AuthEnvironment } from "@/lib/credentials";
import "./companyDataSettings.css";

type Storage = "keychain" | "local" | "none" | "unavailable";
type ProviderStatus = {
  environment: AuthEnvironment;
  secUserAgentConfigured: boolean;
  dartKeyConfigured: boolean;
  secSettingsStorage: Storage;
  dartStorage: Storage;
};

export type CompanyDataSettingsProps = { environment: AuthEnvironment };

const STORAGES = ["keychain", "local", "none", "unavailable"] as const;
const DART_KEY = /^[A-Za-z0-9]{40}$/;
const CONTACT = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;

export function validateCompanySecUserAgent(value: string) {
  const text = value.trim();
  const email = CONTACT.exec(text);
  return text.length >= 3 && text.length <= 180 && /^[\x20-\x7e]+$/.test(text) && Boolean(email && text.slice(0, email.index).trim().replace(/[()<>\-–—]/g, ""));
}

export function validateCompanyDartKey(value: string) {
  return DART_KEY.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseStatus(value: unknown): ProviderStatus {
  if (!isRecord(value) || !["real", "demo", "fixture"].includes(String(value.environment)) ||
    typeof value.secUserAgentConfigured !== "boolean" || typeof value.dartKeyConfigured !== "boolean" ||
    !STORAGES.includes(value.secSettingsStorage as Storage) || !STORAGES.includes(value.dartStorage as Storage)) throw new CredentialApiError("회사 데이터 설정 상태를 확인할 수 없습니다.");
  return {
    environment: value.environment as AuthEnvironment,
    secUserAgentConfigured: value.secUserAgentConfigured,
    dartKeyConfigured: value.dartKeyConfigured,
    secSettingsStorage: value.secSettingsStorage as Storage,
    dartStorage: value.dartStorage as Storage,
  };
}

async function providerRequest(path: string, init: RequestInit, safeFailure: string): Promise<ProviderStatus> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init, cache: "no-store", credentials: "omit",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    if (isCredentialAbortError(error)) throw error;
    throw new CredentialApiError(safeFailure);
  }
  if (!response.ok) throw new CredentialApiError(safeFailure, response.status);
  try {
    return parseStatus(await response.json());
  } catch (error) {
    if (isCredentialAbortError(error)) throw error;
    throw new CredentialApiError(safeFailure);
  }
}

function configured(value: boolean, storage: Storage) {
  if (storage === "unavailable") return "저장소를 확인하세요";
  return value ? "설정됨" : "설정되지 않음";
}

export function CompanyDataSettings({ environment }: CompanyDataSettingsProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [secUserAgent, setSecUserAgent] = useState("");
  const [dartKey, setDartKey] = useState("");
  const setupTokenRef = useRef("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dartRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const auth = await getAuthStatus();
      const next = await providerRequest("/api/company-credentials/status", { method: "GET" }, "회사 데이터 설정 상태를 확인하지 못했습니다.");
      setupTokenRef.current = auth.setupToken;
      setStatus(next);
      setError("");
    } catch (cause) {
      if (!isCredentialAbortError(cause)) setError(cause instanceof CredentialApiError ? cause.message : "회사 데이터 설정 상태를 확인하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, environment]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
      dartRef.current?.focus();
    }
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  function close() {
    if (saving) return;
    setDartKey("");
    setSecUserAgent("");
    setError("");
    setOpen(false);
    triggerRef.current?.focus();
  }

  async function write(path: string, body: object, failure: string) {
    if (!setupTokenRef.current || saving) return;
    setSaving(true);
    setError("");
    try {
      const next = await providerRequest(path, {
        method: "POST", headers: { "X-HTS-Setup": setupTokenRef.current }, body: JSON.stringify(body),
      }, failure);
      setStatus(next);
      setDartKey("");
      setSecUserAgent("");
    } catch (cause) {
      setError(cause instanceof CredentialApiError && cause.status === 403
        ? "설정 권한이 만료되었습니다. 상태를 새로 확인한 뒤 다시 제출하세요."
        : cause instanceof CredentialApiError ? cause.message : failure);
    } finally {
      setSaving(false);
    }
  }

  const fixture = environment === "fixture";
  return <section className="company-data-settings" aria-label="회사·공시 데이터 설정">
    <span className="company-data-settings__badge" data-state={status?.dartKeyConfigured ? "ready" : "idle"}>공시 · {status?.dartKeyConfigured ? "DART 연결 설정됨" : "선택 설정"}</span>
    <button ref={triggerRef} type="button" className="hts-btn" onClick={() => { setOpen(true); void load(); }} aria-haspopup="dialog">회사·공시 설정</button>
    <dialog ref={dialogRef} className="company-data-settings__dialog" aria-labelledby={titleId} aria-modal="true" onCancel={(event) => { event.preventDefault(); close(); }}>
      <header className="company-data-settings__header">
        <h2 id={titleId}>회사·공시 데이터 설정</h2>
        <button type="button" className="hts-btn" onClick={close} disabled={saving}>닫기</button>
      </header>
      <div className="company-data-settings__body">
        <p className="company-data-settings__hint">선택 기능입니다. 설정하지 않아도 키움 시세·관심종목 사용은 계속됩니다.</p>
        {loading && <p role="status" className="company-data-settings__status">저장 상태를 확인하는 중…</p>}
        {status && <div role="status" className="company-data-settings__status">
          <div>SEC 연락처: {configured(status.secUserAgentConfigured, status.secSettingsStorage)}</div>
          <div>DART 키: {configured(status.dartKeyConfigured, status.dartStorage)}</div>
        </div>}
        {fixture && <p className="company-data-settings__hint" role="note">테스트 데이터 환경에서는 실제 SEC/DART 설정을 저장하지 않습니다.</p>}
        {error && <p className="company-data-settings__error" role="alert">{error}</p>}
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!validateCompanySecUserAgent(secUserAgent)) return setError("SEC 영문 앱 이름과 실제 연락 이메일을 함께 입력하세요.");
          void write("/api/company-credentials/sec-user-agent", { secUserAgent }, "SEC 연락처를 저장하지 못했습니다.");
        }}>
          <label htmlFor={`${titleId}-sec`}>SEC 연락처 User-Agent
            <input id={`${titleId}-sec`} value={secUserAgent} onChange={(event) => setSecUserAgent(event.target.value)} placeholder="My HTS support@example.com" autoComplete="off" spellCheck={false} disabled={fixture || saving} aria-describedby={`${titleId}-privacy`} />
          </label>
          <p className="company-data-settings__hint">SEC 요청에만 사용하며, 영문(ASCII) 앱 이름과 실제 연락 이메일이 필요합니다. <a href="https://www.sec.gov/os/accessing-edgar-data" target="_blank" rel="noreferrer">SEC 접근 정책</a></p>
          <button type="submit" className="hts-btn" disabled={fixture || saving}>{saving ? "저장 중…" : "SEC 연락처 저장"}</button>
        </form>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!validateCompanyDartKey(dartKey)) return setError("OpenDART API 키 40자를 입력하세요.");
          void write("/api/company-credentials/dart-key", { dartApiKey: dartKey }, "DART 키를 저장하지 못했습니다.");
        }}>
          <label htmlFor={`${titleId}-dart`}>OpenDART API 키
            <input ref={dartRef} id={`${titleId}-dart`} value={dartKey} onChange={(event) => setDartKey(event.target.value)} type="password" autoComplete="off" spellCheck={false} disabled={fixture || saving} aria-describedby={`${titleId}-privacy`} />
          </label>
          <p id={`${titleId}-privacy`} className="company-data-settings__hint">키는 저장 성공 후 이 화면에서 즉시 비워지며, 브라우저 저장소·URL·상태 화면에는 기록하지 않습니다. <a href="https://opendart.fss.or.kr/" target="_blank" rel="noreferrer">OpenDART 키 발급</a></p>
          <div className="company-data-settings__actions">
            <button type="submit" className="hts-btn" disabled={fixture || saving}>{saving ? "저장 중…" : "DART 키 저장"}</button>
            <button type="button" className="hts-btn" disabled={fixture || saving || !status?.dartKeyConfigured} onClick={() => void write("/api/company-credentials/dart-key/delete", {}, "DART 키를 삭제하지 못했습니다.")}>DART 키 삭제</button>
          </div>
        </form>
      </div>
    </dialog>
  </section>;
}
