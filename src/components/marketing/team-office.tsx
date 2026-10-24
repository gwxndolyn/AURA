"use client";

/**
 * The AI team, shown in AURA's office at rest. This is the brand motif, not a
 * live view: every character is idle at its home desk. Selecting one shows
 * its role and what it is allowed to do (from the real capability registry).
 */
import { useMemo, useState } from "react";
import { OfficeView } from "@/components/office/office-view";
import { mapOfficeState, displayNames } from "@/lib/office/state";
import { AGENT_DEFS } from "@/lib/agents/definitions";
import { capabilityFor } from "@/lib/agents/capabilities";
import { TEAM } from "./team";

const KEYS: string[] = TEAM.map((t) => t.key);
const AGENTS = AGENT_DEFS.filter((d) => KEYS.includes(d.key)).map((d) => ({ key: d.key, name: d.name, role: d.role, status: "IDLE", available: true }));
const NAMES = displayNames(AGENTS);

export function TeamOffice() {
  const [selected, setSelected] = useState<string | null>(null);
  const visual = useMemo(() => mapOfficeState({ agents: AGENTS, tasks: [], interactions: [], now: 0 }), []);
  const sel = TEAM.find((t) => t.key === selected);
  const cap = selected ? capabilityFor(selected) : undefined;
  return (
    <div className="relative">
      <OfficeView agents={visual} selected={selected} onSelect={setSelected} selectedLocation={null} onSelectLocation={() => {}} height={520} label="The AURA team in its office" />
      {sel && (
        <div className="absolute bottom-4 left-4 right-4 max-w-sm rounded-lg border border-white/10 bg-[#111114]/95 p-4 text-sm shadow-xl sm:right-auto" role="dialog" aria-label={`${sel.role}`}>
          <div className="flex items-center gap-2"><span className="font-medium">{NAMES[sel.key] ?? sel.key}</span><span className="text-text-faint">· {sel.role}</span><button onClick={() => setSelected(null)} className="ml-auto text-text-faint hover:text-text" aria-label="Close">×</button></div>
          <p className="mt-1 text-text-muted">{sel.does}</p>
          {cap && <p className="mono mt-2 text-2xs text-text-faint">tools: {cap.tools.join(", ")}{cap.canWriteCode ? "" : " · cannot write code"}</p>}
        </div>
      )}
    </div>
  );
}
