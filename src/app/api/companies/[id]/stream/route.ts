import { subscribe } from "@/lib/events/bus";
import { requireWorkspaceAccess, AuthError } from "@/lib/auth/authz";
import { err } from "@/lib/api";
import type { LiveEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-Sent Events stream of live company events. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await requireWorkspaceAccess(id, "VIEWER");
  } catch (e) {
    if (e instanceof AuthError) return err(e.message, e.status);
    throw e;
  }
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: LiveEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* stream closed */
        }
      };

      controller.enqueue(encoder.encode(`event: open\ndata: {}\n\n`));
      unsubscribe = subscribe(id, send);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* stream closed */
        }
      }, 20000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
