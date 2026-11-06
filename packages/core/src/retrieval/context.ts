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
  register: (title: string, url: string) => string = sequentialIds(),
): AssembledContext {
  const blocks: string[] = [];
  const sources: AssembledContext["sources"] = [];
  let tokens = 0;
  let omitted = 0;
  for (const chunk of chunks) {
    const title = chunk.headingPath.join(" › ") || chunk.title;
    // Cost with a placeholder id: ids are a few characters, and allocating one for a chunk that
    // does not fit would leave a gap in the citation ids.
    const cost = estimateTokens(sourceBlock("S000", title, chunk.url, chunk.content));
    if (tokens + cost > maxTokens) {
      omitted += 1;
      continue;
    }
    const visibleTitle = visitorTitle(chunk);
    const id = register(visibleTitle, chunk.url);
    blocks.push(sourceBlock(id, title, chunk.url, chunk.content));
    sources.push({ id, title: visibleTitle, url: chunk.url, chunkId: chunk.chunkId });
    tokens += cost;
  }
  return { text: blocks.join("\n\n"), sources, tokens, omitted };
}

/** One `<source>` block with escaped attributes and body (see `assembleContext`). */
export function sourceBlock(id: string, title: string, url: string, body: string): string {
  return `<source id="${escapeAttribute(id)}" title="${escapeAttribute(title)}" url="${escapeAttribute(url)}">\n${escapeText(body)}\n</source>`;
}

/**
 * The title a visitor sees under an answer: the heading path without the page name, which every
 * chunk of the page shares ("Consultorios › Boulogne" rather than "Dr. Luis Antonio Ghilino").
 */
export function visitorTitle(chunk: Pick<RetrievedChunk, "headingPath" | "title">): string {
  return chunk.headingPath.slice(1).join(" › ") || chunk.title;
}

function sequentialIds(): (title: string, url: string) => string {
  let next = 0;
  return () => {
    next += 1;
    return `S${next}`;
  };
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
