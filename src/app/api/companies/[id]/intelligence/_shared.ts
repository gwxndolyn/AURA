import { ApiError } from "@/lib/api";
import { EvaluationError } from "@/lib/intelligence/evaluation";

/** Map intelligence-layer domain errors onto the house ApiError contract. */
export async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EvaluationError) throw new ApiError(e.message, e.status);
    const msg = (e as Error).message ?? "";
    if (/not found/i.test(msg)) throw new ApiError(msg, 404);
    if (/^(Illegal|Cannot|Use promotion|Candidate is identical|Integrity)/.test(msg)) throw new ApiError(msg, 409);
    throw e;
  }
}
