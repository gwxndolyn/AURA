"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { AuraMark } from "@/components/shell/sidebar";

/** Shared sign-in / sign-up form. Talks to the existing /api/auth/* routes. */
function Form({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/app";
  const plan = params.get("plan");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "login" ? { email, password } : { email, name, password }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Request failed");
      // New accounts go straight into onboarding to create their first workspace and product.
      // A plan chosen on the pricing page is carried through onboarding to checkout.
      router.push(mode === "register" && !next ? `/onboarding${plan && /^(pro|team)$/.test(plan) ? `?plan=${plan}` : ""}` : safeNext);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const isLogin = mode === "login";
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-[340px]">
        <Link href="/" className="mb-8 flex items-center gap-2">
          <AuraMark />
          <span className="text-sm font-semibold tracking-tight">AURA</span>
        </Link>
        <h1 className="text-xl font-semibold">{isLogin ? "Sign in" : "Create an account"}</h1>
        <p className="mt-1 text-sm text-text-muted">{isLogin ? "Access your AURA workspaces." : "Workspaces you create are private to you and your members."}</p>
        <form onSubmit={submit} className="mt-6 space-y-3" noValidate>
          {!isLogin && (
            <div>
              <label htmlFor="name" className="label">Name</label>
              <input id="name" className="input" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          <div>
            <label htmlFor="email" className="label">Email</label>
            <input id="email" type="email" className="input" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label htmlFor="password" className="label">Password</label>
            <input
              id="password"
              type="password"
              className="input"
              autoComplete={isLogin ? "current-password" : "new-password"}
              required
              minLength={isLogin ? 1 : 10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={!isLogin ? "pw-hint" : undefined}
            />
            {!isLogin && <p id="pw-hint" className="mt-1 text-2xs text-text-faint">At least 10 characters.</p>}
            {isLogin && <Link href="/forgot-password" className="mt-1 inline-block text-2xs text-text-muted underline decoration-border-strong underline-offset-2 hover:text-text">Forgot password?</Link>}
          </div>
          {error && (
            <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-xs text-danger">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isLogin ? "Sign in" : "Create account"}
          </button>
        </form>
        <p className="mt-6 text-xs text-text-muted">
          {isLogin ? "No account? " : "Already have an account? "}
          <Link href={isLogin ? `/register${next ? `?next=${encodeURIComponent(next)}` : ""}` : `/login${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="text-text underline decoration-border-strong underline-offset-2 hover:decoration-text">
            {isLogin ? "Create one" : "Sign in"}
          </Link>
        </p>
        {!isLogin && <p className="mt-3 text-2xs text-text-faint">By creating an account you agree to the <Link href="/terms" className="underline">Terms</Link> and <Link href="/privacy" className="underline">Privacy Policy</Link>.</p>}
      </div>
    </main>
  );
}

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <Form mode={mode} />
    </Suspense>
  );
}
