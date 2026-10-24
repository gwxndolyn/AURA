// Node-only side of instrumentation.ts (never bundled for the edge runtime).
import { startWorker } from "@/lib/jobs/worker";

if ((process.env.AURA_WORKER || "inline") === "inline") startWorker();
