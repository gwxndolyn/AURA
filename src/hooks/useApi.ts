"use client";

import { useCallback, useEffect, useRef, useState } from "react";

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json.data as T;
}

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Simple fetch-with-polling hook. */
export function useQuery<T>(url: string | null, pollMs?: number): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Monotonic request id: a slow response for an older URL/request never overwrites a newer one.
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!url) return;
    const mine = ++seq.current;
    try {
      const d = await fetchJSON<T>(url);
      if (mounted.current && mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mounted.current && mine === seq.current) setError((e as Error).message);
    } finally {
      if (mounted.current && mine === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    mounted.current = true;
    setLoading(Boolean(url));
    load();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (pollMs && url) timer = setInterval(load, pollMs);
    return () => {
      mounted.current = false;
      if (timer) clearInterval(timer);
    };
  }, [load, pollMs, url]);

  return { data, loading, error, refetch: load };
}

/** Mutation helper. */
export function useMutation<TBody = unknown, TResult = unknown>(method: "POST" | "PUT" | "DELETE" = "POST") {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(
    async (url: string, body?: TBody): Promise<TResult> => {
      setLoading(true);
      setError(null);
      try {
        return await fetchJSON<TResult>(url, { method, body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [method],
  );

  return { mutate, loading, error };
}

export { fetchJSON };
