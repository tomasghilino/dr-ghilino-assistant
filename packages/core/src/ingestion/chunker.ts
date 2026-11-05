import { estimateTokens, foldForSearch } from "../lib/text.ts";
import type { ChunkDraft, ExtractedDocument } from "./types.ts";

export interface ChunkingOptions {
  /** Size to aim for when a section is too long and must be split. */
  targetTokens: number;
  /** Hard ceiling. A section at or under it stays whole. */
  maxTokens: number;
  /** Text repeated at the start of the next piece when a section is split. */
  overlapTokens: number;
}

export interface ChunkingContext {
  /** URL to cite when a chunk has no anchor (e.g. llms.txt cites the home page). */
  citeAs?: string | undefined;
}

interface Section {
  path: string[];
  anchor: string | undefined;
  lines: string[];
}

const PATH_SEPARATOR = " › ";

/**
 * Heading-aware chunking.
 *
 * 1. The page outline decides the boundaries: every heading starts a section, and a section's
 *    path is its chain of headings ("Dr. Luis Antonio Ghilino › Consultorios › Boulogne").
 * 2. A section that fits in `maxTokens` becomes exactly one chunk. On this site that means one
 *    chunk per office, per pathology and per FAQ answer: the units visitors ask about.
 * 3. A longer section (a future PDF chapter) is split on line, then sentence, then word
 *    boundaries into pieces of about `targetTokens`, each repeating the last `overlapTokens` of the
 *    previous one so a fact that straddles the cut is still whole in one piece.
 * 4. Every chunk starts with its heading path. An office chunk then says which office it is about
 *    even though its body only says "Jueves desde las 17 h"; that context improves both the
 *    embedding and what the model reads.
 */
export function chunkDocument(
  doc: ExtractedDocument,
  options: ChunkingOptions,
  context: ChunkingContext = {},
): ChunkDraft[] {
  validate(options);
  const sections = toSections(doc);
  const chunks: ChunkDraft[] = [];

  for (const section of sections) {
    if (section.lines.length === 0) continue;
    const header = section.path.length > 0 ? section.path.join(PATH_SEPARATOR) : doc.title;
    const anchorUrl = section.anchor
      ? `${doc.canonicalUrl.replace(/#.*$/, "")}#${section.anchor}`
      : (context.citeAs ?? doc.canonicalUrl);

    for (const body of splitSection(section.lines, header, options)) {
      const content = `${header}\n${body}`;
      chunks.push({
        ordinal: chunks.length,
        headingPath: section.path,
        anchorUrl,
        content,
        searchText: foldForSearch(content),
        tokenEstimate: estimateTokens(content),
      });
    }
  }
  return chunks;
}

function toSections(doc: ExtractedDocument): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; segment: string }> = [];
  let current: Section = { path: [], anchor: undefined, lines: [] };
  sections.push(current);

  for (const block of doc.blocks) {
    if (block.kind === "text") {
      current.lines.push(block.text);
      continue;
    }
    while ((stack.at(-1)?.level ?? 0) >= block.level) stack.pop();
    stack.push({ level: block.level, segment: block.label ?? block.text });
    current = {
      path: stack.map((entry) => entry.segment),
      anchor: block.anchor,
      // When the path shows the short label, the heading's own wording stays in the body.
      lines: block.label ? [block.text] : [],
    };
    sections.push(current);
  }
  return sections;
}

function splitSection(lines: string[], header: string, options: ChunkingOptions): string[] {
  const whole = lines.join("\n");
  if (estimateTokens(`${header}\n${whole}`) <= options.maxTokens) return [whole];

  const budget = Math.max(1, options.targetTokens - estimateTokens(header));
  const units = lines.flatMap((line) => splitToFit(line, budget));
  const pieces: string[] = [];
  let piece: string[] = [];
  let pieceTokens = 0;

  for (const unit of units) {
    const unitTokens = estimateTokens(unit);
    if (piece.length > 0 && pieceTokens + unitTokens > budget) {
      pieces.push(piece.join("\n"));
      piece = overlapTail(piece, options.overlapTokens);
      pieceTokens = estimateTokens(piece.join("\n"));
    }
    piece.push(unit);
    pieceTokens += unitTokens;
  }
  if (piece.length > 0) pieces.push(piece.join("\n"));
  return pieces;
}

/** Break one line into sentences, and a too-long sentence into word runs, until each fits. */
function splitToFit(line: string, budget: number): string[] {
  if (estimateTokens(line) <= budget) return [line];
  const sentences = line.split(/(?<=[.!?])\s+(?=[¿¡"«(]?[\p{Lu}\d])/u);
  if (sentences.length > 1) return sentences.flatMap((sentence) => splitToFit(sentence, budget));
  const words = line.split(/\s+/);
  const runs: string[] = [];
  let run: string[] = [];
  for (const word of words) {
    if (run.length > 0 && estimateTokens([...run, word].join(" ")) > budget) {
      runs.push(run.join(" "));
      run = [];
    }
    run.push(word);
  }
  if (run.length > 0) runs.push(run.join(" "));
  return runs;
}

/** The trailing units of a finished piece, up to `overlapTokens`, to start the next one. */
function overlapTail(units: string[], overlapTokens: number): string[] {
  if (overlapTokens <= 0) return [];
  const tail: string[] = [];
  let tokens = 0;
  for (let i = units.length - 1; i > 0; i--) {
    const unit = units[i] ?? "";
    const unitTokens = estimateTokens(unit);
    if (tokens + unitTokens > overlapTokens) break;
    tail.unshift(unit);
    tokens += unitTokens;
  }
  return tail;
}

function validate(options: ChunkingOptions): void {
  if (options.targetTokens > options.maxTokens) {
    throw new Error("targetTokens must be <= maxTokens");
  }
  if (options.overlapTokens >= options.targetTokens) {
    throw new Error("overlapTokens must be < targetTokens");
  }
}
