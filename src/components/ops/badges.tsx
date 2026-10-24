import { Badge, type Tone } from "@/components/ui/primitives";

const SEV_TONE: Record<string, Tone> = { critical: "danger", high: "danger", medium: "warning", low: "neutral" };
const CERT_LABEL: Record<string, string> = { confirmed: "confirmed failure", warning: "threshold crossed", prediction: "prediction", suspicion: "unverified suspicion" };

export function SeverityBadge({ severity }: { severity: string }) {
  return <Badge tone={SEV_TONE[severity] ?? "neutral"}>{severity}</Badge>;
}

/** Certainty is shown in words so a suspicion is never read as a confirmed failure. */
export function CertaintyBadge({ certainty }: { certainty: string }) {
  return <Badge>{CERT_LABEL[certainty] ?? certainty}</Badge>;
}
