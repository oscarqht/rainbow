import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rainbow — A home for what inspires you",
  description: "Your bookmarks, beautifully organized. Privately stored in your Google Drive.",
  openGraph: {
    title: "Rainbow — A home for what inspires you",
    description: "Your bookmarks, beautifully organized. Privately stored in your Google Drive."
  },
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
