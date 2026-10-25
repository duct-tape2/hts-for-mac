import { describe, expect, it } from "vitest";
import { screenPresentation } from "@/lib/screenPresentation";

describe("screenPresentation", () => {
  it("keeps the reviewed table dimensions, link kinds, and rank pinning", () => {
    expect(screenPresentation("0187")).toMatchObject({ defaultMinWidth: 1050, linkKind: "instrument" });
    expect(screenPresentation("0130")).toMatchObject({ defaultMinWidth: 420, linkKind: "instrument" });
    expect(screenPresentation("0200")).toMatchObject({ defaultMinWidth: 1180, linkKind: "market" });
    expect(screenPresentation("0700")).toMatchObject({ defaultMinWidth: 1000, linkKind: "none" });
    expect(screenPresentation("0198").columns).toMatchObject({ rank: { pinned: true }, name: { pinned: true }, rankChange: { format: "rankChange" } });
  });

  it("keeps reviewed field meaning and the 2797 investor-first layout", () => {
    expect(screenPresentation("0198").columns).toMatchObject({
      price: { label: "기준시점 주가", format: "price" }, changePct: { label: "기준 대비 등락률", format: "percent" }, asOf: { format: "datetime" },
    });
    expect(screenPresentation("0187").columns).toMatchObject({ tradingStrength: { format: "strength", precision: 2 }, marketCap: { label: "시가총액(억원)", width: 116 } });
    expect(screenPresentation("0184").columns).toMatchObject({ previousChangePct: { format: "ratio" }, turnoverRate: { format: "ratio" } });

    const investor = screenPresentation("2797").columns;
    expect(investor.market).toMatchObject({ visible: false });
    expect(investor.price).toMatchObject({ visible: false });
    expect(investor.change).toMatchObject({ visible: false });
    expect(investor.changePct).toMatchObject({ visible: false });
    expect(screenPresentation("2797").title).toBe("업종별 투자자 기준일 순매수");
    expect(["individual", "foreign", "institutional", "securities", "insurance", "investmentTrust", "bank", "pension", "fund", "privateFund", "national", "nativeTrmtForeign", "otherCorporation"].map((key) => investor[key].format)).toEqual(Array(13).fill("netFlow"));
    expect(["sector", "individual", "foreign", "institutional", "securities", "insurance", "investmentTrust", "bank", "pension", "fund", "privateFund", "national", "nativeTrmtForeign", "otherCorporation"].map((key) => investor[key].order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(screenPresentation("0186").columns).toMatchObject({ sellPrice: { label: "매도호가" }, buyPrice: { label: "매수호가" }, previousVolume: { label: "전일거래량" } });
  });
});
