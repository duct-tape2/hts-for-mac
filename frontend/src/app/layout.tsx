import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { StoreProvider } from "@/lib/store";
import "flexlayout-react/style/dark.css";
import "./globals.css";
import "@/components/htsClassic.css";

export const metadata: Metadata = {
  title: "HTS for Mac · 국내·미국주식 분석",
  description:
    "키움증권 REST API를 이용해 macOS에서 국내·미국주식 시세, 호가, 일봉과 로컬 관심종목을 조회하는 개인용 조회·분석 작업공간입니다. 키움 공식 HTS/WTS/MTS가 아니며 제휴·협력 관계가 없습니다.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <StoreProvider>
          <AppShell>{children}</AppShell>
        </StoreProvider>
      </body>
    </html>
  );
}
