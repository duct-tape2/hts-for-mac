"use client";

import { useEffect, useId, useRef, useState } from "react";
import { searchScreens, type ScreenDefinition } from "@/lib/screenCatalog";
import type { Market } from "@/lib/types";

export type ScreenLauncherProps = {
  market: Market;
  onOpen: (screen: ScreenDefinition) => void;
};

function marketLabel(market?: Market) {
  return market === "KR" ? "국내" : market === "US" ? "미국" : "앱";
}

export function ScreenLauncher({ market, onOpen }: ScreenLauncherProps) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const resultsId = `${inputId}-results`;
  const optionId = (index: number) => `${resultsId}-option-${index}`;
  const results = searchScreens(query, market);
  const menuOpen = focused && open;
  const activeId = activeIndex >= 0 && activeIndex < results.length ? optionId(activeIndex) : undefined;

  useEffect(() => {
    setActiveIndex(-1);
  }, [market, query]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setFocused(false);
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("mousedown", closeOnOutsidePointer);
    return () => document.removeEventListener("mousedown", closeOnOutsidePointer);
  }, []);

  useEffect(() => {
    const focusScreenSearch = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key !== "Home" || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return;
      if (target instanceof Element && target.closest("input,textarea,select,[contenteditable=true]")) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    document.addEventListener("keydown", focusScreenSearch);
    return () => document.removeEventListener("keydown", focusScreenSearch);
  }, []);

  function openScreen(screen: ScreenDefinition) {
    onOpen(screen);
    setQuery("");
    setFocused(false);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.blur();
  }

  function submit() {
    if (!query.trim() && activeIndex < 0) return;
    const index = activeIndex >= 0 ? activeIndex : 0;
    const selected = results[index];
    if (selected) openScreen(selected);
  }

  return (
    <div ref={containerRef} className="relative min-w-0" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setFocused(false); setOpen(false); setActiveIndex(-1); }
    }}>
      <form
        className="flex min-w-0 items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="sr-only" htmlFor={inputId}>
          화면번호·이름
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="search"
          className="field !w-32 !py-0.5 sm:!w-40"
          value={query}
          placeholder="화면번호·이름"
          title="Home 키로 화면 검색 · 번호 입력 후 Enter"
          aria-label="화면번호·이름"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setFocused(true);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && results.length > 0) {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(index + 1, results.length - 1));
            } else if (event.key === "ArrowUp" && results.length > 0) {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => (index <= 0 ? results.length - 1 : index - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              setActiveIndex(-1);
            }
          }}
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          aria-controls={resultsId}
          aria-activedescendant={activeId}
        />
        <button type="submit" className="hts-btn" aria-label="화면 열기">
          화면 열기
        </button>
      </form>

      {menuOpen && (
        <div id={resultsId} className="absolute left-0 z-30 mt-0.5 w-[min(24rem,calc(100vw-1rem))] overflow-hidden border border-ink-700 bg-[#101925] shadow-lg" role="region" aria-label="화면 검색 결과">
          {results.length > 0 ? (
            <ul className="m-0 max-h-64 list-none overflow-auto p-0" role="listbox" aria-label="화면 검색 결과 목록">
              {results.map((screen, index) => {
                const active = index === activeIndex;
                const label = `${screen.code ?? "앱"} ${screen.name} · ${marketLabel(screen.market)}`;
                return (
                  <li key={screen.id} role="presentation">
                    <button
                      id={optionId(index)}
                      type="button"
                      role="option"
                      aria-label={label}
                      aria-selected={active}
                      className={`flex w-full items-start gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-ink-800 ${active ? "bg-ink-800 ring-1 ring-inset ring-brass-400" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => openScreen(screen)}
                    >
                      <span className="w-11 shrink-0 font-mono font-medium text-cream-50">{screen.code ?? "앱"}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-cream-50">{screen.name}</span>
                        <span className="block truncate text-[10px] text-cream-500">{screen.description}</span>
                      </span>
                      <span className="shrink-0 text-[10px] text-cream-500">{marketLabel(screen.market)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-2 py-2 text-[11px] text-cream-300" role="status">
              지원하는 화면번호 또는 이름을 찾지 못했습니다.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
