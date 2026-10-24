"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveEvent } from "@/lib/types";

interface PersistedEvent {
  id: string;
  companyId: string;
  type: LiveEvent["type"];
  actor: string | null;
  actorName: string | null;
  role: string | null;
  message: string;
  level: LiveEvent["level"];
  meta: string;
  createdAt: string;
}

/**
 * Company event stream. On mount it backfills recent PERSISTED events (so a
 * page refresh never loses history), then subscribes to the SSE stream for new
 * ones. Returns newest-first events and a version counter for refetch triggers.
 */
export function useLiveEvents(companyId: string | null, max = 60) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [version, setVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setEvents([]);

    fetch(`/api/companies/${companyId}/events?limit=${Math.min(100, max)}`)
      .then((r) => r.json())
      .then((j: { ok: boolean; data?: PersistedEvent[] }) => {
        if (cancelled || !j.ok || !j.data) return;
        const history: LiveEvent[] = j.data.map((e) => {
          let meta: Record<string, unknown> | undefined;
          try {
            meta = JSON.parse(e.meta);
          } catch {
            meta = undefined;
          }
          return {
            id: e.id,
            companyId: e.companyId,
            type: e.type,
            actor: e.actor ?? undefined,
            actorName: e.actorName ?? undefined,
            role: e.role ?? undefined,
            message: e.message,
            level: e.level,
            meta,
            createdAt: e.createdAt,
          };
        });
        // Merge: live events received during the fetch stay on top; dedupe by id.
        setEvents((live) => {
          const seen = new Set(live.map((e) => e.id));
          return [...live, ...history.filter((h) => !seen.has(h.id))].slice(0, max);
        });
      })
      .catch(() => {
        /* history is best-effort; the live stream still works */
      });

    const es = new EventSource(`/api/companies/${companyId}/stream`);
    esRef.current = es;
    es.addEventListener("open", () => setConnected(true));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as LiveEvent;
        if (!data.id) return;
        setEvents((prev) => [data, ...prev.filter((p) => p.id !== data.id)].slice(0, max));
        setVersion((v) => v + 1);
      } catch {
        /* malformed frame — ignore */
      }
    };

    return () => {
      cancelled = true;
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [companyId, max]);

  return { events, version, connected };
}
