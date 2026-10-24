import { prisma } from "@/lib/db";

/**
 * Context retrieval layer. We never dump the whole company history into a
 * prompt. We retrieve a small, relevant slice: the agent's recent long-term
 * memories plus a lightweight keyword match on short-term memories.
 */

export async function remember(
  agentId: string,
  content: string,
  kind: "short" | "long" = "short",
  relevance = 1,
) {
  await prisma.agentMemory.create({ data: { agentId, content, kind, relevance } });
  // Bound short-term memory to avoid unbounded growth.
  if (kind === "short") {
    const extra = await prisma.agentMemory.findMany({
      where: { agentId, kind: "short" },
      orderBy: { createdAt: "desc" },
      skip: 20,
      select: { id: true },
    });
    if (extra.length) {
      await prisma.agentMemory.deleteMany({ where: { id: { in: extra.map((e) => e.id) } } });
    }
  }
}

export async function retrieveContext(agentId: string, query: string): Promise<string[]> {
  const [longTerm, shortTerm] = await Promise.all([
    prisma.agentMemory.findMany({
      where: { agentId, kind: "long" },
      orderBy: { relevance: "desc" },
      take: 5,
    }),
    prisma.agentMemory.findMany({
      where: { agentId, kind: "short" },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);

  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
  const scored = shortTerm
    .map((m) => ({
      m,
      score: terms.reduce((s, t) => s + (m.content.toLowerCase().includes(t) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.m);

  return [...longTerm, ...scored].map((m) => `- ${m.content}`);
}
