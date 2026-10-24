import { EventEmitter } from "events";
import type { LiveEvent } from "@/lib/types";

/**
 * Centralized in-process event bus. Powers the live dashboard via SSE.
 *
 * In-memory by default (no Redis required to run). The emitter is stored on
 * globalThis so it survives Next.js dev HMR and is shared across route modules
 * within the same server process.
 */

const globalForBus = globalThis as unknown as { auraBus?: EventEmitter };

function bus(): EventEmitter {
  if (!globalForBus.auraBus) {
    const e = new EventEmitter();
    e.setMaxListeners(1000);
    globalForBus.auraBus = e;
  }
  return globalForBus.auraBus;
}

const CHANNEL = "event";

export function publish(event: LiveEvent) {
  bus().emit(CHANNEL, event);
  bus().emit(`${CHANNEL}:${event.companyId}`, event);
}

export function subscribe(companyId: string, handler: (e: LiveEvent) => void): () => void {
  const chan = `${CHANNEL}:${companyId}`;
  bus().on(chan, handler);
  return () => bus().off(chan, handler);
}
