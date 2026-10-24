import { NextResponse } from "next/server";
import { z, ZodError, ZodTypeAny } from "zod";
import { AuthError } from "@/lib/auth/authz";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function err(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function parseBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new ApiError("Invalid JSON body", 400);
  }
  try {
    return schema.parse(json) as z.infer<S>;
  } catch (e) {
    if (e instanceof ZodError) {
      throw new ApiError(e.errors.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "), 422);
    }
    throw e;
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Wrap a route handler with consistent error handling. */
export function handler<Ctx>(fn: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof AuthError) return err(e.message, e.status);
      if (e instanceof ApiError) return err(e.message, e.status);
      console.error("[api error]", e);
      return err((e as Error).message || "Internal error", 500);
    }
  };
}
