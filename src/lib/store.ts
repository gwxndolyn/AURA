"use client";

import { create } from "zustand";

export interface Toast {
  id: string;
  title: string;
  description?: string;
  level: "info" | "success" | "warning" | "danger";
}

interface AppState {
  companyId: string | null;
  setCompanyId: (id: string | null) => void;

  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: string) => void;

  commandOpen: boolean;
  setCommandOpen: (v: boolean) => void;
}

export const useApp = create<AppState>((set) => ({
  companyId: null,
  setCompanyId: (id) => {
    set({ companyId: id });
    if (typeof window !== "undefined") {
      if (id) localStorage.setItem("aura.companyId", id);
      else localStorage.removeItem("aura.companyId");
    }
  },

  toasts: [],
  toast: (t) => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 5000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  commandOpen: false,
  setCommandOpen: (v) => set({ commandOpen: v }),
}));
