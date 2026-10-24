"use client";

import { use, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar, MobileSidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { CommandPalette } from "@/components/shell/command-palette";
import { useQuery } from "@/hooks/useApi";
import { useApp } from "@/lib/store";

interface CompanyLite {
  id: string;
  name: string;
  status: string;
}

export default function CompanyLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pathname = usePathname();
  const { setCompanyId } = useApp();
  const { data: company } = useQuery<CompanyLite>(`/api/companies/${id}`, 8000);
  const { data: usage } = useQuery<{ usage: { cost: number } }>(`/api/companies/${id}/usage`, 10000);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setCompanyId(id);
  }, [id, setCompanyId]);

  useEffect(() => setNavOpen(false), [pathname]);

  return (
    <div className="flex h-screen overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[200] focus:rounded focus:bg-bg-elevated focus:px-2 focus:py-1">
        Skip to content
      </a>
      <Sidebar companyId={id} companyName={company?.name} />
      <MobileSidebar companyId={id} companyName={company?.name} open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          companyId={id}
          companyName={company?.name ?? "…"}
          status={company?.status ?? "BUILDING"}
          cost={usage?.usage.cost ?? 0}
          onOpenNav={() => setNavOpen(true)}
        />
        <main id="main" className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
      <CommandPalette companyId={id} />
    </div>
  );
}
