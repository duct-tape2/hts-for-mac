"use client";

import { useEffect, useRef, useState } from "react";
import { quoteKey, quoteStream } from "./quoteStream";
import type { Instrument } from "./types";
export { quoteKey } from "./quoteStream";

/** Shared, reference-counted stream. No per-panel polling or broker sockets. */
export function useLiveQuotes(instruments: Instrument[], refreshKey = 0) {
  const key = JSON.stringify(instruments.map(quoteKey).sort());
  const current = useRef(instruments);
  current.current = instruments;
  const previousRefresh = useRef(refreshKey);
  const [, update] = useState(0);
  useEffect(() => {
    const unsubscribe = quoteStream.subscribe(current.current, () => update((n) => n + 1));
    update((n) => n + 1);
    return unsubscribe;
  }, [key]);
  useEffect(() => {
    if (previousRefresh.current !== refreshKey) quoteStream.refresh();
    previousRefresh.current = refreshKey;
  }, [refreshKey]);
  return quoteStream.read(instruments);
}

export function useLiveQuote(instrument: Instrument, refreshKey = 0, active = true) {
  const { quotes, errors } = useLiveQuotes(active ? [instrument] : [], refreshKey);
  const key = quoteKey(instrument);
  return { quote: quotes[key] ?? null, quoteError: errors[key] ?? "" };
}
