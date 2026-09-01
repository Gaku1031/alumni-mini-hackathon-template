import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Next.js × Supabase テンプレート",
  description: "Next.js + Supabase のスターターテンプレート",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
