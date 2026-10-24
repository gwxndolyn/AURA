/**
 * Next.js instrumentation hook: starts the durable job worker inside the
 * server process unless AURA_WORKER=external (then run `npm run worker`
 * separately) or AURA_WORKER=off. Node runtime only.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./instrumentation-node");
}
