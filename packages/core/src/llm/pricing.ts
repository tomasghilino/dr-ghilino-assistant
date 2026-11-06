import type { LlmUsage } from "./types.ts";

/**
 * List prices in US dollars per million tokens, for prompts up to 100K tokens (our prompts are
 * a few thousand). Cache writes (5-minute) cost 1.25× input; cache reads as listed. Checked on
 * 2026-11-06; update when prices change. Unknown models estimate to null, never to a guess.
 */
const PRICES: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};

/** Voyage voyage-4: US$0.06 per million tokens (the first 200M per account are free). */
const EMBEDDING_PRICES: Record<string, number> = { "voyage-4": 0.06 };

export function estimateLlmCostUsd(model: string, usage: LlmUsage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.cacheReadTokens * price.cacheRead) /
    1_000_000
  );
}

export function estimateEmbeddingCostUsd(model: string, tokens: number): number | null {
  const price = EMBEDDING_PRICES[model];
  return price === undefined ? null : (tokens * price) / 1_000_000;
}
