import type { SourceRef } from "../domain/types.ts";
import { estimateTokens } from "../lib/text.ts";
import type { RetrievedChunk } from "./types.ts";

export interface AssembledContext {
  /** Text for the model: one `<source>` block per chunk, in rank order. */
  text: string;
  /** Citations, one per `<source>` block, in the same order (S1, S2, ...). */
  sources: Array<SourceRef & { chunkId: string }>;
  tokens: number;
  /** Chunks left out because they did not fit in the budget. */
  omitted: number;
}

/**
 * Turn retrieved chunks into the context the model reads (ADR 0011).
 *
 * Each chunk becomes `<source id="S1" title="…" url="…">…</source>`. Retrieved text is data, not
 * instructions: the system prompt (Phase 4) says so, and here we make sure the data cannot pretend
 * to be structure. `<` and `>` in the content are escaped, so a page that contained
 * `</source><source id="S9">` or `</context>` stays plain text inside its own block.
 *
 * Chunks are added in rank order while they fit in `maxTokens`; one that does not fit is skipped
 * and the next, smaller one may still fit.
 */
export function assembleContext(
  chunks: readonly RetrievedChunk[],
  maxTokens: number,
): AssembledContext {
  const blocks: string[] = [];
  const sources: AssembledContext["sources"] = [];
  let tokens = 0;
  let omitted = 0;
  for (const chunk of chunks) {
    const id = `S${sources.length + 1}`;
    const block = `<source id="${id}" title="${escapeAttribute(chunk.headingPath.join(" › ") || chunk.title)}" url="${escapeAttribute(chunk.url)}">\n${escapeText(chunk.content)}\n</source>`;
    const cost = estimateTokens(block);
    if (tokens + cost > maxTokens) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
    sources.push({ id, title: chunk.title, url: chunk.url, chunkId: chunk.chunkId });
    tokens += cost;
  }
  return { text: blocks.join("\n\n"), sources, tokens, omitted };
}

function escapeText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s+/g, " ");
}
