export type LogicalRange = { from: number; to: number };
export type ChartKeyboardInput = {
  key: string;
  code?: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};
export type ChartKeyboardAction =
  | { kind: "zoom"; direction: "in" | "out" }
  | { kind: "pan"; direction: "left" | "right"; singleBar: boolean }
  | { kind: "fit" }
  | { kind: "interval"; direction: "previous" | "next" };

const MIN_VISIBLE_BARS = 5;
const LOGICAL_PADDING = 3;

export function chartKeyboardAction(input: ChartKeyboardInput): ChartKeyboardAction | null {
  const hasNonShiftModifier = input.ctrlKey || input.altKey || input.metaKey;
  if (input.shiftKey && !hasNonShiftModifier && isDigit(input, "1")) return { kind: "interval", direction: "previous" };
  if (input.shiftKey && !hasNonShiftModifier && isDigit(input, "2")) return { kind: "interval", direction: "next" };
  if (hasNonShiftModifier) {
    if (input.ctrlKey && !input.altKey && !input.metaKey && !input.shiftKey && input.key === "ArrowLeft") return { kind: "pan", direction: "left", singleBar: true };
    if (input.ctrlKey && !input.altKey && !input.metaKey && !input.shiftKey && input.key === "ArrowRight") return { kind: "pan", direction: "right", singleBar: true };
    return null;
  }
  if (!input.shiftKey && input.key === "ArrowLeft") return { kind: "pan", direction: "left", singleBar: false };
  if (!input.shiftKey && input.key === "ArrowRight") return { kind: "pan", direction: "right", singleBar: false };
  if (input.key === "+" || input.code === "NumpadAdd" || input.key === "ArrowUp") return { kind: "zoom", direction: "in" };
  if (input.key === "-" || input.code === "NumpadSubtract" || input.key === "ArrowDown") return { kind: "zoom", direction: "out" };
  if (input.key === "*" || input.code === "NumpadMultiply") return { kind: "fit" };
  return null;
}

export function zoomLogicalRange(range: LogicalRange | null, loadedBars: number, direction: "in" | "out") {
  const current = normalizeRange(range, loadedBars);
  if (!current) return null;
  const bounds = logicalBounds(loadedBars);
  const span = current.to - current.from;
  const targetSpan = direction === "in"
    ? Math.max(MIN_VISIBLE_BARS, span * 0.8)
    : Math.min(bounds.to - bounds.from, span * 1.25);
  const next = clampRange({ from: center(current) - targetSpan / 2, to: center(current) + targetSpan / 2 }, bounds);
  return equivalentRange(current, next) ? null : next;
}

export function panLogicalRange(range: LogicalRange | null, loadedBars: number, direction: "left" | "right", singleBar: boolean) {
  const current = normalizeRange(range, loadedBars);
  if (!current) return null;
  const span = current.to - current.from;
  const amount = singleBar ? 1 : Math.max(1, span * 0.2);
  const offset = direction === "left" ? -amount : amount;
  const next = clampRange({ from: current.from + offset, to: current.to + offset }, logicalBounds(loadedBars));
  return equivalentRange(current, next) ? null : next;
}

export function cycleChartInterval<T extends string>(current: T, intervals: readonly T[], direction: "previous" | "next") {
  const index = intervals.indexOf(current);
  if (index < 0 || intervals.length === 0) return current;
  const offset = direction === "previous" ? -1 : 1;
  return intervals[(index + offset + intervals.length) % intervals.length];
}

function isDigit(input: ChartKeyboardInput, digit: "1" | "2") {
  return input.key === digit || input.code === `Digit${digit}` || (digit === "1" && input.key === "!") || (digit === "2" && input.key === "@");
}

function logicalBounds(loadedBars: number) {
  const count = Math.max(1, Math.floor(loadedBars));
  return { from: -LOGICAL_PADDING, to: count + LOGICAL_PADDING };
}

function normalizeRange(range: LogicalRange | null, loadedBars: number) {
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to <= range.from) return null;
  return clampRange(range, logicalBounds(loadedBars));
}

function clampRange(range: LogicalRange, bounds: LogicalRange) {
  const maxSpan = bounds.to - bounds.from;
  const span = Math.min(maxSpan, Math.max(MIN_VISIBLE_BARS, range.to - range.from));
  const from = Math.max(bounds.from, Math.min(range.from, bounds.to - span));
  return { from, to: from + span };
}

function center(range: LogicalRange) {
  return (range.from + range.to) / 2;
}

function equivalentRange(a: LogicalRange, b: LogicalRange) {
  return Math.abs(a.from - b.from) < 0.000_001 && Math.abs(a.to - b.to) < 0.000_001;
}
