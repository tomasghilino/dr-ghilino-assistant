import { foldForSearch } from "../lib/text.ts";
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

    const shingles = shinglesOf(item.chunk.content);
    let inside = 0;
    for (const shingle of shingles) if (covered.has(shingle)) inside++;
    decision.containment = shingles.size === 0 ? 0 : inside / shingles.size;
    if (shingles.size > 0 && decision.containment >= threshold) {
      decision.keep = false;
      decision.reason = "near_duplicate";
      continue;
    }
    pending.push(shingles);
  }
  return decisions;
}

/** Word 3-grams of the chunk body (the first line is the heading path), accent-folded. */
function shinglesOf(content: string): Set<string> {
  const body = foldForSearch(content.split("\n").slice(1).join(" "));
  const words = body.match(/[\p{L}\p{N}$]+/gu) ?? [];
  const shingles = new Set<string>();
  if (words.length < 3) {
    if (words.length > 0) shingles.add(words.join(" "));
    return shingles;
  }
  for (let i = 0; i + 3 <= words.length; i++) shingles.add(words.slice(i, i + 3).join(" "));
  return shingles;
}
