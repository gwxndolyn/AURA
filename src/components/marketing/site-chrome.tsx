import Link from "next/link";
import { AuraMark } from "@/components/shell/sidebar";

/** Shared marketing header + footer (real destinations only). */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-[#0b0b0d]/80 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5" aria-label="Main">
        <Link href="/" className="flex items-center gap-2"><AuraMark /><span className="text-sm font-semibold tracking-tight">AURA</span></Link>
        <div className="hidden items-center gap-5 text-sm text-text-muted md:flex">
          <Link href="/#how" className="hover:text-text">How it works</Link>
          <Link href="/#team" className="hover:text-text">The team</Link>
          <Link href="/pricing" className="hover:text-text">Pricing</Link>
          <Link href="/docs" className="hover:text-text">Docs</Link>
          <Link href="/security" className="hover:text-text">Security</Link>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/login" className="btn-ghost btn-sm">Sign in</Link>
          <Link href="/register" className="btn-primary btn-sm" data-testid="nav-start">Start building</Link>
        </div>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  const support = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
  return (
    <footer className="border-t border-white/5">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 text-sm sm:grid-cols-2 md:grid-cols-4">
        <div>
          <Link href="/" className="flex items-center gap-2"><AuraMark /><span className="font-semibold">AURA</span></Link>
          <p className="mt-2 max-w-xs text-text-muted">Your AI team. From idea to working software.</p>
        </div>
        <div><div className="mb-2 text-2xs uppercase tracking-wider text-text-faint">Product</div><ul className="space-y-1.5 text-text-muted"><li><Link href="/#how" className="hover:text-text">How it works</Link></li><li><Link href="/pricing" className="hover:text-text">Pricing</Link></li><li><Link href="/#faq" className="hover:text-text">FAQ</Link></li></ul></div>
        <div><div className="mb-2 text-2xs uppercase tracking-wider text-text-faint">Resources</div><ul className="space-y-1.5 text-text-muted"><li><Link href="/docs" className="hover:text-text">Documentation</Link></li><li><Link href="/security" className="hover:text-text">Security</Link></li>{support && <li><a href={`mailto:${support}`} className="hover:text-text">Support</a></li>}</ul></div>
        <div><div className="mb-2 text-2xs uppercase tracking-wider text-text-faint">Legal</div><ul className="space-y-1.5 text-text-muted"><li><Link href="/terms" className="hover:text-text">Terms of service</Link></li><li><Link href="/privacy" className="hover:text-text">Privacy policy</Link></li></ul></div>
      </div>
      <div className="mx-auto max-w-6xl px-5 pb-8 text-2xs text-text-faint">© {new Date().getFullYear()} {process.env.NEXT_PUBLIC_COMPANY_NAME || "AURA"}</div>
    </footer>
  );
}

export function ProsePage({ title, updated, children }: { title: string; updated?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0b0b0d]">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 py-14">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {updated && <p className="mt-2 text-xs text-text-faint">Last updated {updated}</p>}
        <div className="prose-aura mt-8 space-y-5 text-[15px] leading-relaxed text-text-muted [&_h2]:mt-10 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-text [&_li]:ml-5 [&_li]:list-disc [&_a]:underline">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}
