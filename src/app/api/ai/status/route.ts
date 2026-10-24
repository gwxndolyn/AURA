import { ok } from "@/lib/api";
import { aiMode, MODELS } from "@/lib/ai/claude";
import { BUDGET } from "@/lib/ai/budget";
import { dockerAvailable } from "@/lib/sandbox/docker";

export const dynamic = "force-dynamic";

export async function GET() {
  return ok({
    mode: aiMode(),
    models: MODELS,
    budget: BUDGET,
    sandbox: (await dockerAvailable()) ? "docker" : "simulated",
  });
}
