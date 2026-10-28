import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { site } from "@/config/site";
import { fontDisplay, fontMono, fontSans } from "@/theme/fonts";
import { theme } from "@/theme/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: site.name, template: `%s · ${site.name}` },
  description: site.description,
  applicationName: site.name,
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: theme.colors.bg,
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Renderização sempre dinâmica: a CSP usa um nonce novo por requisição (ARCHITECTURE §8).
  await connection();
  return (
    <html lang="pt-BR" className={`${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable}`}>
      <body className="bg-bg font-sans text-fg antialiased">{children}</body>
    </html>
  );
}
