"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { AuraMark } from "@/components/shell/sidebar";

function Shell({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-[340px]">
        <Link href="/" className="mb-8 flex items-center gap-2"><AuraMark /><span className="text-sm font-semibold tracking-tight">AURA</span></Link>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-text-muted">{desc}</p>
        {children}
        <p className="mt-6 text-xs text-text-muted"><Link href="/login" className="text-text underline decoration-border-strong underline-offset-2">Back to sign in</Link></p>
      </div>
    </main>
  );
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{ done: boolean; emailConfigured?: boolean; devLink?: string; error?: string }>({ done: false });
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await fetch("/api/auth/password-reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }).then((x) => x.json());
    setBusy(false);
    setState(r.ok ? { done: true, emailConfigured: r.data.emailConfigured, devLink: r.data.devLink } : { done: false, error: r.error });
  }
  return (
    <Shell title="Reset your password" desc="Enter your account email and we'll send you a reset link.">
      {state.done ? (
        <div className="mt-6 space-y-2 text-sm" role="status" data-testid="reset-requested">
          <p>If an account exists for {email}, a reset link is on its way. It expires in one hour.</p>
          {!state.emailConfigured && <p className="text-xs text-warning">Email delivery is not configured on this server, so no email was sent. Ask the administrator to set RESEND_API_KEY and EMAIL_FROM.</p>}
          {state.devLink && <p className="text-xs"><a className="underline" href={state.devLink} data-testid="dev-reset-link">Development: open the reset link</a></p>}
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-3">
          <div><label htmlFor="email" className="label">Email</label><input id="email" type="email" className="input" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
          {state.error && <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-xs text-danger">{state.error}</p>}
          <button className="btn-primary w-full" disabled={busy}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Send reset link</button>
        </form>
      )}
    </Shell>
  );
}

function Reset() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await fetch("/api/auth/password-reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password }) }).then((x) => x.json());
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "Reset failed");
    router.push("/login?reset=1");
  }
  return (
    <Shell title="Choose a new password" desc="At least 8 characters.">
      {!token ? <p className="mt-6 text-sm text-danger">This link is missing its token. Request a new one.</p> : (
        <form onSubmit={submit} className="mt-6 space-y-3">
          <div><label htmlFor="password" className="label">New password</label><input id="password" type="password" minLength={8} className="input" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></div>
          {error && <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-xs text-danger">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Set password</button>
        </form>
      )}
    </Shell>
  );
}

export function ResetPasswordForm() {
  return <Suspense fallback={<main className="min-h-screen" />}><Reset /></Suspense>;
}
