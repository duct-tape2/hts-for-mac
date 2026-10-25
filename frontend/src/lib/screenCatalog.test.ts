import { describe, expect, it } from "vitest";
import { SCREEN_CATALOG, searchScreens } from "@/lib/screenCatalog";

describe("screen catalog", () => {
  it("keeps supported official shortcuts and local app views searchable", () => {
    expect(searchScreens("0101", "KR")[0]).toMatchObject({ code: "0101", component: "book", market: "KR" });
    expect(searchScreens("키움현재가", "KR")[0].code).toBe("0101");
    expect(searchScreens("종목별투자자", "KR")[0]).toMatchObject({ code: "0796", component: "investors" });
    expect(searchScreens("일별 시세 데이터", "KR")[0]).toMatchObject({ id: "app-history", component: "history" });
    expect(searchScreens("체결정보", "KR")[0]).toMatchObject({ component: "analysis", featureId: "kr_tape" });
  });

  it("returns the current market plus app views for a blank query", () => {
    const kr = searchScreens("", "KR");
    const us = searchScreens("", "US");
    expect(kr.map((screen) => screen.code).filter(Boolean)).toEqual(expect.arrayContaining(["0101", "0130", "0600", "0601", "0180", "0796", "0198", "0187", "0186", "0184", "0162", "0602", "0211", "0780", "2797", "0200", "0700"]));
    expect(us.map((screen) => screen.code).filter(Boolean)).toEqual(["2010", "2020", "0601"]);
    expect(kr.every((screen) => !screen.market || screen.market === "KR")).toBe(true);
    expect(us.every((screen) => !screen.market || screen.market === "US")).toBe(true);
  });

  it("keeps exact codes stable and resolves an explicit other-market code", () => {
    expect(searchScreens("0601", "KR")).toMatchObject([{ code: "0601", market: "KR" }]);
    expect(searchScreens("0601", "US")).toMatchObject([{ code: "0601", market: "US" }]);
    expect(searchScreens("0600", "US")).toMatchObject([{ code: "0600", market: "KR" }]);
    expect(searchScreens("06", "KR").map((screen) => screen.code)).toEqual(expect.arrayContaining(["0600", "0601", "0602"]));
  });

  it("does not expose unsupported or trading/account screens", () => {
    const codes = SCREEN_CATALOG.flatMap((screen) => (screen.code ? [screen.code] : []));
    expect(codes).not.toEqual(expect.arrayContaining(["0104", "6600", "0150", "2000", "2150", "2151"]));
  });
});
