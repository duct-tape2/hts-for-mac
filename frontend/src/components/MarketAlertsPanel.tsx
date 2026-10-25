"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatPrice, formatVol } from "@/lib/format";
import { quoteKey, useLiveQuotes } from "@/lib/useLiveQuote";
import { sameFeed } from "@/lib/types";
import type { Instrument, Quote } from "@/lib/types";
import {
  createAlertRule,
  evaluateAlertUpdate,
  hasFreshAlertValue,
  isFreshVerifiedQuote,
  ALERT_RULE_LIMIT,
  ALERT_STORAGE_KEY,
  mutateAlertStorage,
  readAlertStorage,
  rearmAlert,
  removeAlert,
  type AlertKind,
  type MarketAlertEvent,
  type MarketAlertRule,
} from "./marketAlerts";
import { createAlertEngineOwnership, type AlertOwnershipState } from "./alertOwnership";

type Props = {
  instrument: Instrument;
  quote: Quote | null;
};

/**
 * Provider-owned alert engine. It shares the app quote stream and monitors
 * every armed rule in the active runtime environment.
 */
export function useMarketAlertsService(environment: Instrument["environment"]) {
  const [rules, setRules] = useState<MarketAlertRule[]>([]);
  const [history, setHistory] = useState<MarketAlertEvent[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [ownership, setOwnership] = useState<AlertOwnershipState>("waiting");
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  const signatures = useRef<Record<string, string | undefined>>({});

  useEffect(() => {
    const stored = readAlertStorage();
    setRules(stored.rules);
    setHistory(stored.history);
    setHydrated(true);
    const sync = (event: StorageEvent) => {
      if (event.key !== ALERT_STORAGE_KEY) return;
      const next = readAlertStorage();
      setRules(next.rules);
      setHistory(next.history);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useEffect(() => {
    const controller = createAlertEngineOwnership({ environment, onState: setOwnership });
    controller.start();
    return controller.release;
  }, [environment]);

  const mutate = useCallback(async <T,>(operation: (current: { rules: MarketAlertRule[]; history: MarketAlertEvent[] }) => { storage: { rules: MarketAlertRule[]; history: MarketAlertEvent[] }; result: T }, signal?: AbortSignal) => {
    const committed = await mutateAlertStorage(operation, { signal });
    // A no-op engine evaluation rehydrates storage into new array references.
    // Keep the current references in that case so its effect does not poll the
    // same receipt again merely because evaluation completed.
    setRules((current) => sameAlertSnapshot(current, committed.storage.rules) ? current : committed.storage.rules);
    setHistory((current) => sameAlertSnapshot(current, committed.storage.history) ? current : committed.storage.history);
    return committed.result;
  }, []);

  const monitoredInstruments = useMemo(() => {
    const seen = new Set<string>();
    if (ownership !== "owner") return [];
    return rules
      .filter((rule) => rule.armed && rule.environment === environment && rule.instrument.environment === environment)
      .flatMap((rule) => {
        if (seen.has(rule.feedKey)) return [];
        seen.add(rule.feedKey);
        return [rule.instrument];
      });
  }, [environment, ownership, rules]);
  const { quotes } = useLiveQuotes(monitoredInstruments);

  useEffect(() => {
    if (!hydrated || ownership !== "owner") return;
    const controller = new AbortController();
    void (async () => {
      const fired: MarketAlertEvent[] = [];
      for (const instrument of monitoredInstruments) {
        if (controller.signal.aborted) return;
        const feedKey = quoteKey(instrument);
        const next = await mutate((current) => {
          const evaluation = evaluateAlertUpdate({
            rules: current.rules,
            history: current.history,
            feedKey,
            instrument,
            quote: quotes[feedKey] ?? null,
            previousSignature: signatures.current[feedKey],
          });
          return { storage: { rules: evaluation.rules, history: evaluation.history }, result: evaluation };
        }, controller.signal);
        if (controller.signal.aborted) return;
        if (next.signature) signatures.current[feedKey] = next.signature;
        fired.push(...next.fired);
      }
      if (notificationPermission === "granted") fired.forEach((event) => {
        try { new Notification(event.fixture ? "시세 알림 · 샘플" : "시세 알림", { body: notificationBody(event) }); } catch { /* optional browser delivery */ }
      });
    })().catch(() => undefined);
    return () => controller.abort();
  }, [hydrated, monitoredInstruments, mutate, notificationPermission, ownership, quotes]);

  async function addRule(instrument: Instrument, kind: AlertKind, threshold: number) {
    if (instrument.environment !== environment) return false;
    const feedKey = quoteKey(instrument);
    const candidate = createAlertRule({ feedKey, instrument, kind, threshold });
    return mutate((current) => current.rules.length >= ALERT_RULE_LIMIT
      ? { storage: current, result: false }
      : { storage: { rules: [...current.rules, candidate], history: current.history }, result: true });
  }

  async function requestNotificationPermission() {
    if (typeof Notification === "undefined") return;
    try {
      setNotificationPermission(await Notification.requestPermission());
    } catch {
      setNotificationPermission("denied");
    }
  }

  return {
    rules,
    history,
    hydrated,
    environment,
    notificationPermission,
    ownership,
    addRule,
    rearm: (id: string) => mutate((current) => ({ storage: { rules: rearmAlert(current.rules, id), history: current.history }, result: undefined })),
    remove: (id: string) => mutate((current) => ({ storage: { rules: removeAlert(current.rules, id), history: current.history }, result: undefined })),
    requestNotificationPermission,
  };
}

function sameAlertSnapshot<T>(current: T[], next: T[]) {
  return current === next || JSON.stringify(current) === JSON.stringify(next);
}

type MarketAlertsService = ReturnType<typeof useMarketAlertsService>;

const MarketAlertsContext = createContext<MarketAlertsService | null>(null);

export function MarketAlertsProvider({ environment, children }: { environment: Instrument["environment"]; children: ReactNode }) {
  const service = useMarketAlertsService(environment);
  return <MarketAlertsContext.Provider value={service}>{children}</MarketAlertsContext.Provider>;
}

function useMarketAlerts() {
  const service = useContext(MarketAlertsContext);
  if (!service) throw new Error("MarketAlertsProvider missing");
  return service;
}

export function MarketAlertsPanel({ instrument, quote }: Props) {
  const feedKey = quoteKey(instrument);
  const [kind, setKind] = useState<AlertKind>("above");
  const [thresholdText, setThresholdText] = useState("");
  const [formError, setFormError] = useState("");
  const alerts = useMarketAlerts();
  const visibleRules = useMemo(() => alerts.rules.filter((rule) => rule.feedKey === feedKey), [alerts.rules, feedKey]);
  const visibleHistory = useMemo(() => alerts.history.filter((event) => event.feedKey === feedKey).slice(0, 5), [alerts.history, feedKey]);
  const threshold = Number(thresholdText);
  const thresholdValid = Number.isFinite(threshold) && threshold > 0;
  const fixture = quote?.environment === "fixture" || quote?.source === "fixture";

  async function addRule() {
    if (!thresholdValid) {
      setFormError("0보다 큰 숫자를 입력하세요.");
      return;
    }
    if (instrument.environment !== alerts.environment) {
      setFormError("현재 환경과 일치하는 종목만 알림으로 등록할 수 있습니다.");
      return;
    }
    if (!await alerts.addRule(instrument, kind, threshold)) {
      setFormError("알림은 이 브라우저에서 최대 100개까지 등록할 수 있습니다.");
      return;
    }
    setThresholdText("");
    setFormError("");
  }

  const quoteStatus = quoteStatusText(instrument, quote);

  return (
    <section className="panel flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#101925]" aria-label="시세 알림">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-800 px-2 py-1">
        <div>
          <h2 className="text-xs font-semibold text-cream-50">시세 알림</h2>
          <p className="text-[10px] text-cream-500">{instrument.stkCd} · {instrument.currency === "KRW" ? "원화" : "달러"} · 같은 원본의 창과 동기화</p>
        </div>
        {fixture && <span className="bg-[#e5ad39]/15 px-1 py-0.5 text-[10px] text-[#e5ad39]">샘플 데이터</span>}
      </div>

      <div className="shrink-0 border-b border-ink-800 px-2 py-1.5">
        <p className={"text-[10px] " + (isFreshVerifiedQuote(instrument, quote) ? "text-cream-300" : "text-[#e5ad39]")}>{quoteStatus}</p>
        <div className="mt-1 flex gap-1">
          <label className="sr-only" htmlFor="alert-kind">알림 종류</label>
          <select id="alert-kind" className="field !w-[5.8rem] !py-0.5" value={kind} onChange={(event) => setKind(event.target.value as AlertKind)}>
            <option value="above">가격 이상</option>
            <option value="below">가격 이하</option>
            <option value="volume">누적 거래량</option>
          </select>
          <label className="sr-only" htmlFor="alert-threshold">알림 기준값</label>
          <input
            id="alert-threshold"
            className="field min-w-0 flex-1 !py-0.5 font-mono"
            type="number"
            inputMode="decimal"
            min="0"
            step={kind === "volume" ? "1" : instrument.currency === "KRW" ? "1" : "0.01"}
            value={thresholdText}
            onChange={(event) => setThresholdText(event.target.value)}
            placeholder={kind === "volume" ? "거래량" : instrument.currency === "KRW" ? "가격(원)" : "가격(USD)"}
          />
          <button className="btn btn-primary shrink-0 !px-1.5 !py-0.5 text-[10px]" type="button" onClick={() => void addRule()} disabled={!thresholdValid}>
            추가
          </button>
        </div>
        {formError && <p className="mt-1 text-[10px] text-up" role="alert">{formError}</p>}
        <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-cream-500">
          <span>{ownershipText(alerts.ownership)}</span>
          {alerts.notificationPermission === "granted" ? (
            <span>브라우저 알림 허용됨</span>
          ) : alerts.notificationPermission === "unsupported" ? (
            <span>브라우저 알림 미지원</span>
          ) : (
            <button className="text-[#e5ad39] hover:text-cream-50" type="button" onClick={alerts.requestNotificationPermission}>
              브라우저 알림 허용
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="border-b border-ink-800 px-2 py-1 text-[10px] text-cream-500">등록 알림 {visibleRules.length}</div>
        {visibleRules.length ? (
          visibleRules.map((rule) => (
            <div key={rule.id} className="flex min-h-8 items-center gap-1 border-b border-ink-800 px-2 py-1 text-[11px]">
              <span className={rule.armed ? "text-cream-50" : "text-cream-500"}>{ruleLabel(rule)}</span>
              <span className={"ml-auto text-[10px] " + (rule.armed ? "text-up" : "text-[#e5ad39]")}>{rule.armed ? "대기" : "발동됨"}</span>
              <button className="px-1 text-[10px] text-cream-500 hover:text-[#e5ad39]" type="button" onClick={() => void alerts.rearm(rule.id)} disabled={rule.armed}>
                재설정
              </button>
              <button className="px-1 text-[10px] text-cream-500 hover:text-up" type="button" onClick={() => void alerts.remove(rule.id)} aria-label={ruleLabel(rule) + " 삭제"}>
                ×
              </button>
            </div>
          ))
        ) : (
          <p className="px-2 py-3 text-center text-[11px] text-cream-500">가격 또는 누적 거래량 기준을 추가하세요.</p>
        )}

        <div className="border-b border-ink-800 px-2 py-1 text-[10px] text-cream-500">최근 발동 (최대 30건 저장)</div>
        {visibleHistory.length ? (
          visibleHistory.map((event) => (
            <div key={event.id} className="border-b border-ink-800 px-2 py-1 text-[10px] text-cream-300">
              <span>{event.fixture ? "샘플 · " : ""}{eventLabel(event)} · {event.source === "kiwoom" ? "키움" : "샘플"}</span>
            </div>
          ))
        ) : (
          <p className="px-2 py-3 text-center text-[11px] text-cream-500">발동 기록이 없습니다.</p>
        )}
      </div>
    </section>
  );
}

function ruleLabel(rule: MarketAlertRule) {
  const value = rule.kind === "volume" ? formatVol(rule.threshold) : formatPrice(rule.threshold, rule.currency);
  return (rule.kind === "above" ? "가격 ≥ " : rule.kind === "below" ? "가격 ≤ " : "누적 거래량 ≥ ") + value;
}

function eventLabel(event: MarketAlertEvent) {
  const value = event.kind === "volume" ? formatVol(event.value) : formatPrice(event.value, event.currency);
  return (event.kind === "above" ? "가격 이상 " : event.kind === "below" ? "가격 이하 " : "누적 거래량 ") + value;
}

function notificationBody(event: MarketAlertEvent) {
  return event.symbol + " · " + eventLabel(event) + (event.fixture ? " (샘플 데이터)" : "");
}

function ownershipText(ownership: AlertOwnershipState) {
  if (ownership === "owner") return "이 창이 감시 중입니다. 새로 검증된 시세에서 한 번만 알립니다.";
  if (ownership === "waiting") return "다른 창이 감시 중입니다. 이 창은 규칙과 기록만 동기화합니다.";
  if (ownership === "unsupported") return "브라우저 잠금 미지원: 중복 방지 감시는 중지되고 규칙만 편집할 수 있습니다.";
  return "브라우저 잠금을 사용할 수 없어 감시는 중지되었습니다.";
}

function quoteStatusText(instrument: Instrument, quote: Quote | null) {
  if (!quote) return "시세 수신 대기 중입니다. 시세가 없으면 알림은 발동하지 않습니다.";
  if (!sameFeed(instrument, quote)) return "다른 종목 시세는 사용하지 않습니다.";
  const priceFresh = hasFreshAlertValue(instrument, quote, "above");
  const volumeFresh = hasFreshAlertValue(instrument, quote, "volume");
  if (!priceFresh && !volumeFresh) return "지연·미수신·오류 시세에서는 알림을 발동하지 않습니다.";
  if (!priceFresh) return "최신 거래량만 확인되어 거래량 알림만 발동할 수 있습니다.";
  if (!volumeFresh) return "최신 가격만 확인되어 가격 알림만 발동할 수 있습니다.";
  return quote.environment === "fixture" ? "샘플 시세입니다. 발동 기록에는 샘플로 표시됩니다." : "검증된 최신 시세를 수신했습니다.";
}
