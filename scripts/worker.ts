// Standalone job worker + scheduler: `npm run worker` (set AURA_WORKER=external on the web servers).
// Validates configuration first; exits non-zero (so the process manager restarts/alerts) if it is unusable.
import { validateRuntimeConfig } from "@/lib/runtime/config";
import { startWorker } from "@/lib/jobs/worker";

const v = validateRuntimeConfig();
for (const w of v.warnings) console.warn(`[aura-worker] warning: ${w}`);
if (v.errors.length) {
  for (const e of v.errors) console.error(`[aura-worker] config error: ${e}`);
  process.exit(2);
}
startWorker("standalone");
