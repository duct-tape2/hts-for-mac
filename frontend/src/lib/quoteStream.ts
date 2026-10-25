import { createParser } from "eventsource-parser";
import { parseQuote } from "./api";
import { feedKeyOf } from "./types";
import type { Instrument, Quote } from "./types";

export const quoteKey = (instrument: Instrument) => JSON.stringify(feedKeyOf(instrument));
type Entry = { instrument: Instrument; listeners: Set<() => void>; quote?: Quote; error: string };
// Long-lived SSE must not occupy one of the browser's small HTTP/1.1 pool for
// the Next application origin. The endpoint is fixed loopback only; the API
// permits the local UI origins by CORS and callers cannot choose a host.
const LOOPBACK_STREAM_URL = "http://127.0.0.1:8010/api/market/stream";

/** One HTTP stream per window; the server shares upstream subscriptions across windows. */
export class QuoteStream {
  private entries = new Map<string, Entry>();
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private connectedKeys = "";
  private retry = 0;
  private visibilityListening = false;

  subscribe(instruments: Instrument[], listener: () => void) {
    this.bindVisibility();
    const keys = new Set<string>();
    for (const instrument of instruments) {
      const key = quoteKey(instrument);
      keys.add(key);
      const entry = this.entries.get(key) ?? { instrument, listeners: new Set(), error: "" };
      entry.listeners.add(listener);
      this.entries.set(key, entry);
    }
    this.schedule();
    return () => {
      for (const key of keys) {
        const entry = this.entries.get(key);
        entry?.listeners.delete(listener);
        if (!entry?.listeners.size) this.entries.delete(key);
      }
      this.schedule();
    };
  }

  read(instruments: Instrument[]) {
    const quotes: Record<string, Quote> = {}, errors: Record<string, string> = {};
    for (const instrument of instruments) {
      const key = quoteKey(instrument), entry = this.entries.get(key);
      if (entry?.quote) quotes[key] = entry.quote;
      if (entry?.error) errors[key] = entry.error;
    }
    return { quotes, errors };
  }

  refresh() { this.schedule(true); }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = null;
    this.timer = null;
    this.connectedKeys = "";
    this.entries.clear();
    this.unbindVisibility();
  }

  private bindVisibility() {
    if (this.visibilityListening || typeof document === "undefined") return;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityListening = true;
  }

  private unbindVisibility() {
    if (!this.visibilityListening || typeof document === "undefined") return;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityListening = false;
  }

  private hidden() { return typeof document !== "undefined" && document.visibilityState === "hidden"; }

  private pauseForHiddenTab() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.connectedKeys = "";
    for (const entry of this.entries.values()) {
      if (!entry.quote || entry.quote.source === "fixture") continue;
      entry.error = "비활성 탭에서는 실시간 시세 연결을 일시 중지합니다.";
      entry.quote = { ...entry.quote, status: "stale", bookLive: false, bookNote: entry.error };
      this.notify(entry);
    }
  }

  private onVisibilityChange = () => {
    if (this.hidden()) this.pauseForHiddenTab();
    else {
      this.retry = 0;
      this.schedule(true, 0);
    }
  };

  private schedule(force = false, delay = 120) {
    if (this.hidden()) { this.pauseForHiddenTab(); return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const keys = JSON.stringify([...this.entries.keys()].sort());
      if (!force && this.controller && keys === this.connectedKeys) return;
      this.controller?.abort();
      this.controller = null;
      this.connectedKeys = keys;
      if (!this.entries.size) { this.retry = 0; return; }
      const controller = new AbortController();
      this.controller = controller;
      void this.connect(controller);
    }, delay);
  }

  private notify(entry: Entry) { entry.listeners.forEach((listener) => listener()); }

  private fail(message: string) {
    for (const entry of this.entries.values()) {
      entry.error = message;
      if (entry.quote) entry.quote = { ...entry.quote, status: "stale", bookLive: false, bookNote: message };
      this.notify(entry);
    }
  }

  private async connect(controller: AbortController) {
    const { signal } = controller;
    try {
      const response = await fetch(LOOPBACK_STREAM_URL, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ instruments: [...this.entries.values()].slice(0, 200).map(({ instrument }) => instrument) }), signal,
      });
      if (signal.aborted) return;
      if (!response.ok || !response.body) throw new Error("시세 연결을 열지 못했습니다.");
      for (const entry of [...this.entries.values()].slice(200)) {
        entry.error = "이 창의 동시 구독 한도는 200종목입니다. 사용하지 않는 종목을 닫아 주세요.";
        if (entry.quote) entry.quote = { ...entry.quote, status: "stale", bookLive: false };
        this.notify(entry);
      }
      const parser = createParser({
        onEvent: (event) => {
          if (signal.aborted || !event.data) return;
          try {
            if (event.event === "stream-error") { this.fail("시세 구독을 열지 못했습니다. 잠시 후 재연결합니다."); return; }
            if (event.event === "stream-retry") {
              const value = JSON.parse(event.data) as { retryAfterMs?: unknown };
              const delay = typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs)
                ? Math.max(0, Math.min(15_000, value.retryAfterMs))
                : 1_000;
              this.retry = 0;
              controller.abort();
              if (this.controller === controller) this.controller = null;
              this.schedule(true, delay);
              return;
            }
            if (event.event === "quote-error") {
              const value = JSON.parse(event.data) as { identity: Instrument };
              const entry = this.entries.get(quoteKey(value.identity));
              if (entry) {
                entry.error = "키움 시세 조회 실패 · 재시도 중";
                if (entry.quote) entry.quote = { ...entry.quote, status: "stale", bookLive: false };
                this.notify(entry);
              }
              return;
            }
            if (event.event && event.event !== "quote") return;
            const quote = parseQuote(JSON.parse(event.data));
            const entry = this.entries.get(quoteKey(quote));
            if (!entry) return;
            entry.quote = quote;
            entry.error = quote.status === "error" ? quote.note : "";
            this.retry = 0;
            this.notify(entry);
          } catch {
            this.fail("시세 응답 형식 오류 · 마지막 수신값을 표시합니다.");
          }
        },
      });
      const reader = response.body.getReader(), decoder = new TextDecoder();
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } finally { await reader.cancel().catch(() => undefined); }
      if (!signal.aborted) throw new Error("시세 연결이 종료되었습니다.");
    } catch {
      if (signal.aborted) return;
      this.fail("시세 연결 재시도 중 · 마지막 수신 시각을 확인하세요.");
      this.schedule(true, Math.min(15000, 1000 * 2 ** this.retry++));
    }
  }
}

export const quoteStream = new QuoteStream();
