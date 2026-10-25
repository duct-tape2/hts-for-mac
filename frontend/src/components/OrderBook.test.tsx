import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderBook } from "@/components/OrderBook";
import { fixtureQuote, samsung } from "@/test/fixtures";

afterEach(cleanup);

describe("OrderBook", () => {
  it("keeps descending backend asks above the best ask nearest the current trade", () => {
    const quote = fixtureQuote(samsung, {
      last: 71500,
      asks: [
        { price: 71600, qty: 2 },
        { price: 71510, qty: 4 },
      ],
      bids: [{ price: 71490, qty: 3 }],
    });
    render(createElement(OrderBook, { quote, selectedPrice: null, onSelectPrice: vi.fn() }));

    const highAsk = screen.getByText("71,600원").closest("button");
    const bestAsk = screen.getByText("71,510원").closest("button");
    expect(highAsk).not.toBeNull();
    expect(bestAsk).not.toBeNull();
    expect(highAsk?.compareDocumentPosition(bestAsk!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("renders every ten-level side, including valid prices far from the last trade, and only selects a reference price", async () => {
    const user = userEvent.setup();
    const onSelectPrice = vi.fn();
    const asks = Array.from({ length: 10 }, (_, index) => ({ price: index === 0 ? 100000 : 71600 - index * 10, qty: index + 1 }));
    const bids = Array.from({ length: 10 }, (_, index) => ({ price: 71490 - index * 10, qty: index + 1 }));
    render(createElement(OrderBook, { quote: fixtureQuote(samsung, { last: 71500, asks, bids }), selectedPrice: null, onSelectPrice }));

    expect(screen.getAllByRole("button", { name: /매도 호가 .* 가격 참조/ }).length).toBe(10);
    expect(screen.getAllByRole("button", { name: /매수 호가 .* 가격 참조/ }).length).toBe(10);
    await user.click(screen.getByRole("button", { name: "매도 호가 100,000원 가격 참조" }));
    expect(onSelectPrice).toHaveBeenCalledWith(100000);
  });

  it("does not manufacture precise totals or a valid spread from incomplete or crossed depth", () => {
    render(
      createElement(OrderBook, {
        quote: fixtureQuote(samsung, {
          prevClose: null,
          asks: [{ price: 70100, qty: 1 }, { price: 70000, qty: null }],
          bids: [{ price: 70010, qty: 7 }],
        }),
        selectedPrice: null,
        onSelectPrice: vi.fn(),
      }),
    );

    expect(screen.getByText("일부 미수신")).toBeInTheDocument();
    expect(screen.getByText("교차")).toBeInTheDocument();
  });

  it("shows independently supplied trade and book receipt freshness", () => {
    render(
      createElement(OrderBook, {
        quote: fixtureQuote(samsung, { tradeReceivedAt: "2026-10-24T01:02:03Z", bookReceivedAt: "2026-10-24T01:02:04Z" }),
        selectedPrice: null,
        onSelectPrice: vi.fn(),
      }),
    );

    expect(screen.getByTitle("체결 시세 수신 시각")).toBeInTheDocument();
    expect(screen.getByTitle("호가 수신 시각")).toBeInTheDocument();
  });
});
