import type { Metadata } from "next";
import "./globals.css";
import "reactflow/dist/style.css";
import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "AURA — Autonomous AI Company",
  description:
    "An AI company that builds itself. Deploy autonomous AI agents to build, operate, attack, defend, and evolve a software company.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <Providers>
          {children}
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
