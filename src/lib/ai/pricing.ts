// Approximate per-million-token USD pricing by model family. Used for cost
// estimation in the UI. Values are configurable and clearly approximate.
export interface Price {
  inPerM: number;
  outPerM: number;
}

const PRICING: Record<string, Price> = {
  // family prefix -> price
  "claude-opus": { inPerM: 15, outPerM: 75 },
  "claude-sonnet": { inPerM: 3, outPerM: 15 },
  "claude-haiku": { inPerM: 0.8, outPerM: 4 },
  "claude-fable": { inPerM: 1, outPerM: 5 },
};

export function priceFor(model: string): Price {
  const key = Object.keys(PRICING).find((k) => model.startsWith(k));
  return key ? PRICING[key] : { inPerM: 3, outPerM: 15 };
}

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = priceFor(model);
  return (tokensIn / 1_000_000) * p.inPerM + (tokensOut / 1_000_000) * p.outPerM;
}
