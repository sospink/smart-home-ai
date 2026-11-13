import type { Metadata } from "next";
import { GlassFilter } from "@/components/ui/GlassFilter";
import { ToastProvider } from "@/components/ui/toast";
import { ThemeProvider } from "@/lib/theme";
import "./globals.css";

/* App Router 在根布局统一加载产品字体；该规则仅适用于 Pages Router 的 _document。 */
/* eslint-disable @next/next/no-page-custom-font */

export const metadata: Metadata = {
  title: "基于智慧家居场景的大语言模型智能体科研应用平台",
  description: "AI 智能家居管理平台 - 基于 LLM 的智能体科研应用一体机",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className="light" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/* Google Fonts: Oswald (hero display) + Playfair Display (headings) + Inter (body) + Manrope (stitch) + Plus Jakarta Sans (aura) */}
        <link
          href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500;600;700&family=Manrope:wght@200;300;400;500;600;700;800&family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
        {/* Material Symbols Outlined — used by stitch landing page */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ transition: 'background 0.25s ease, color 0.25s ease' }}>
        {/* SVG glass distortion filter — MUST be first child of body (Rule #1) */}
        <GlassFilter />
        <ThemeProvider>
          <ToastProvider>
            {children}
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
