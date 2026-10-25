import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { QuoteSummary } from "@/components/TradingDesk2";
import { fixtureQuote, samsung } from "@/test/fixtures";

describe("QuoteSummary", () => {
  it("keeps fixture and missing-price state explicit", () => {
    const quote = fixtureQuote(samsung, { last: null, change: null, changePct: null, bid: null, ask: null, midPrice: null });
    const { rerender } = render(createElement(QuoteSummary, { instrument: samsung, quote, error: "", selectedPrice: null }));

    expect(screen.getByText("출처 fixture")).toBeInTheDocument();
    expect(screen.getByText("체결가 미수신")).toBeInTheDocument();
    expect(screen.getByLabelText("선택 종목 현재가").querySelector(".quote-main strong")).toHaveTextContent("—");

    rerender(createElement(QuoteSummary, { instrument: samsung, quote, error: "스트림 재연결 중", selectedPrice: null }));
    expect(screen.getByText("스트림 재연결 중")).toBeInTheDocument();

    rerender(createElement(QuoteSummary, { instrument: samsung, quote: null, error: "서버 오류", selectedPrice: null }));
    expect(screen.getByText("서버 오류")).toBeInTheDocument();
    expect(screen.queryByText("70,000원")).not.toBeInTheDocument();
  });
});
