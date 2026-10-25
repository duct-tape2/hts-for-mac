"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api, isAbortError } from "@/lib/api";
import { pushRecent, readRecent, type RecentSymbol } from "@/lib/recent";
import type { Instrument, Market } from "@/lib/types";

export type TickerHit = Instrument;

type Props = {
  market: Market;
  value: string;
  onChange: (value: string) => void;
  onPick: (hit: TickerHit) => void;
  placeholder?: string;
  showRecent?: boolean;
  selectedValue?: string;
  disabled?: boolean;
};

export function TickerSearch({ market, value, onChange, onPick, placeholder = "종목코드 또는 이름", showRecent = false, selectedValue, disabled = false }: Props) {
  const [hits, setHits] = useState<TickerHit[]>([]);
  const [recents, setRecents] = useState<RecentSymbol[]>([]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [note, setNote] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dirty, setDirty] = useState(false);
  const searchId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const toolbarMode = showRecent && selectedValue !== undefined;
  const synchronized = toolbarMode && !dirty && value === selectedValue;

  useEffect(() => {
    setRecents(readRecent().filter((row) => row.market === market));
  }, [market]);

  useEffect(() => {
    if (toolbarMode) setDirty(false);
  }, [market, selectedValue, toolbarMode]);

  useEffect(() => {
    const q = value.trim();
    if (synchronized) {
      setHits([]);
      setNote("");
      return;
    }
    if (!q) {
      setHits([]);
      setNote("");
      return;
    }
    const controller = new AbortController();
    setHits([]);
    setNote("검색 중…");
    let attempts = 0;
    let timer: number;
    const search = () => {
      attempts += 1;
      void api
        .searchSymbols(q, market, controller.signal)
        .then((data) => {
          if (controller.signal.aborted) return;
          setHits(data.results.filter((row) => row.market === market));
          if (data.note.includes("symbol index is loading")) {
            setNote(attempts < 30 ? "종목 목록을 받는 중… 잠시 기다려 주세요." : "종목 목록 준비가 지연되고 있습니다. 잠시 후 다시 검색해 주세요.");
            if (attempts < 30) timer = window.setTimeout(search, 1000);
          } else {
            setNote(data.note.includes("unsupported") ? "현재 지원 범위의 종목만 표시합니다." : data.note || (data.complete ? "" : "검색 결과가 일부일 수 있습니다."));
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted && !isAbortError(error)) {
            setHits([]);
            setNote(error instanceof Error ? error.message : "종목 검색에 실패했습니다.");
          }
        });
    };
    timer = window.setTimeout(search, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [market, selectedValue, synchronized, value]);

  useEffect(() => {
    setActiveIndex(-1);
  }, [hits, market, recents, showRecent, value]);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setFocused(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(hit: TickerHit) {
    const next = pushRecent(hit);
    setRecents(next.filter((row) => row.market === market));
    setDirty(false);
    onPick(hit);
    setOpen(false);
    inputRef.current?.blur();
    setFocused(false);
    setActiveIndex(-1);
  }

  const menuOn = !disabled && focused && open;
  const list = hits.length > 0 ? hits : showRecent && (!value.trim() || synchronized) ? recents : [];
  const activeId = activeIndex >= 0 && activeIndex < list.length ? searchId + "-option-" + activeIndex : undefined;

  return (
    <div ref={boxRef} className="relative min-w-0">
      <label className="sr-only" htmlFor={searchId}>
        {market === "KR" ? "국내 종목 검색" : "미국 종목 검색"}
      </label>
      <input
        id={searchId}
        ref={inputRef}
        type="search"
        className={"field !py-0.5 " + (market === "US" ? "uppercase" : "")}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        onFocus={() => {
          if (showRecent) setRecents(readRecent().filter((row) => row.market === market));
          setFocused(true);
          setOpen(true);
          if (synchronized) inputRef.current?.select();
        }}
        onChange={(event) => {
          const next = market === "US" ? event.target.value.toUpperCase() : event.target.value;
          if (toolbarMode) setDirty(true);
          onChange(next);
          setFocused(true);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && list.length) {
            event.preventDefault();
            setOpen(true);
            setFocused(true);
            setActiveIndex((index) => Math.min(index + 1, list.length - 1));
          } else if (event.key === "ArrowUp" && list.length) {
            event.preventDefault();
            setOpen(true);
            setFocused(true);
            setActiveIndex((index) => (index <= 0 ? list.length - 1 : index - 1));
          } else if (event.key === "Enter" && list.length) {
            event.preventDefault();
            pick(list[activeIndex >= 0 ? activeIndex : 0]);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            setActiveIndex(-1);
          }
        }}
        aria-autocomplete="list"
        aria-expanded={menuOn}
        aria-controls={searchId + "-results"}
        aria-activedescendant={activeId}
      />
      {menuOn && (list.length > 0 || note) && (
        <div id={searchId + "-results"} className="absolute z-30 mt-0.5 max-h-56 w-full overflow-auto border border-ink-700 bg-[#101925] shadow-lg" role="listbox">
          {hits.length === 0 && showRecent && (!value.trim() || synchronized) && <p className="px-2 py-1 text-[10px] text-cream-500">최근 선택</p>}
          {list.map((hit, index) => {
            const active = index === activeIndex;
            return (
              <button
                id={searchId + "-option-" + index}
                key={[hit.market, hit.stkCd, hit.listingVenue, hit.quoteVenue].join("-")}
                type="button"
                role="option"
                aria-selected={active}
                className={"flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-ink-800 " + (active ? "bg-ink-800 ring-1 ring-inset ring-[#e5ad39]" : "")}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => pick(hit)}
              >
                <span className="w-12 shrink-0 font-mono font-medium text-cream-50">{hit.stkCd}</span>
                <span className="min-w-0 flex-1 truncate text-cream-300">{hit.stkNm}</span>
                <span className="shrink-0 text-[10px] text-cream-500" title={"시장: " + marketLabel(hit.market) + " · 상장: " + hit.listingVenue + " · 호가: " + hit.quoteVenue + " · 환경: " + environmentLabel(hit.environment)}>
                  {marketLabel(hit.market)} · {hit.listingVenue}/{hit.quoteVenue} · {environmentLabel(hit.environment)}
                </span>
              </button>
            );
          })}
          {note && <p className="border-t border-ink-800 px-2 py-1 text-[10px] text-cream-500">{note}</p>}
        </div>
      )}
    </div>
  );
}

function marketLabel(market: Market) {
  return market === "KR" ? "국내" : "미국";
}

function environmentLabel(environment: Instrument["environment"]) {
  return { fixture: "샘플", demo: "데모", real: "실환경" }[environment];
}
