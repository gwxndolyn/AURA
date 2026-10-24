"use client";

import { ReactNode } from "react";

/**
 * Lightweight providers wrapper. We use native fetch + Zustand + SSE rather
 * than TanStack Query to keep the dependency surface minimal; the hooks in
 * src/hooks provide caching/polling where needed.
 */
export function Providers({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
