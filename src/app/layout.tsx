import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "드론 배송 3D 시뮬레이터",
  description: "도심 아파트 단지 드론 배송 구간별 시간 시뮬레이션",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
