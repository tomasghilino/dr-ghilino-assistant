import { bodyShingles, containment } from "../lib/shingles.ts";
import type { ChunkDraft } from "./types.ts";

export interface DedupeInput {
  /** Lower number = more authoritative source. */
  priority: number;
  chunk: ChunkDraft;
  contentHash: string;
}

export interface DedupeDecision {
  keep: boolean;
  reason?: "exact_duplicate" | "near_duplicate";
  /** Share of this chunk's word 3-grams already present in more authoritative chunks. */
  containment: number;
}

/**
 * Cross-source duplicate detection.
 *
 * llms.txt restates the home page in other words and other groupings (one bullet list for both
 * offices, versus one section per office on the page). Pairwise similarity would miss that, so
 * we ask a different question: is this chunk's content already *covered* by the more
 * authoritative sources taken together? Coverage is the containment of its word 3-grams
 * ("shingles") in the union of the shingles of every higher-priority chunk. At or above the
 * threshold the chunk is dropped; below, it carries something new and is kept.
 *
 * Exact duplicates (same content hash) are dropped regardless of priority, keeping the first.
 * The heading-path line is ignored, because it is shared by design and would inflate overlap.
 */
export function dedupeChunks(items: DedupeInput[], threshold: number): DedupeDecision[] {
  const decisions: DedupeDecision[] = items.map(() => ({ keep: true, containment: 0 }));
  const seenHashes = new Set<string>();
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.priority - b.item.priority || a.index - b.index);

  const covered = new Set<string>();
  let pending: Array<Set<string>> = [];
  let currentPriority: number | undefined;

  for (const { item, index } of order) {
    if (item.priority !== currentPriority) {
      // Chunks of the same priority never cover each other, only strictly higher ones do.
      for (const shingles of pending) for (const shingle of shingles) covered.add(shingle);
      pending = [];
      currentPriority = item.priority;
    }
    const decision = decisions[index] as DedupeDecision;
    if (seenHashes.has(item.contentHash)) {
      decision.keep = false;
      decision.reason = "exact_duplicate";
      decision.containment = 1;
      continue;
    }
    seenHashes.add(item.contentHash);

    const shingles = bodyShingles(item.chunk.content);
    decision.containment = containment(shingles, covered);
    if (shingles.size > 0 && decision.containment >= threshold) {
      decision.keep = false;
      decision.reason = "near_duplicate";
      continue;
    }
    pending.push(shingles);
  }
  return decisions;
}
