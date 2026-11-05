import { normalizeWhitespace } from "../lib/text.ts";
import type { Block, ExtractedDocument } from "./types.ts";

export interface MarkdownExtractionOptions {
  /** Drop sections whose heading matches one of these (case-insensitive), with their content. */
  excludeHeadings?: readonly string[] | undefined;
}

/**
 * Minimal Markdown reader for curated text sources (llms.txt today, admin notes later):
 * ATX headings, paragraphs, list items and blockquotes. Links keep their text, emphasis and code
 * markers are removed. It is not a full CommonMark parser, on purpose: the inputs are ours.
 */
export function extractMarkdown(
  markdown: string,
  url: string,
  options: MarkdownExtractionOptions = {},
): ExtractedDocument {
  const excluded = new Set((options.excludeHeadings ?? []).map((heading) => heading.toLowerCase()));
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let skipBelowLevel: number | undefined;

  const flush = () => {
    const text = inline(paragraph.join(" "));
    paragraph = [];
    if (text && skipBelowLevel === undefined) blocks.push({ kind: "text", text });
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      flush();
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = inline(heading[2]);
      if (skipBelowLevel !== undefined && level <= skipBelowLevel) skipBelowLevel = undefined;
      if (excluded.has(text.toLowerCase())) {
        skipBelowLevel = level;
        continue;
      }
      if (skipBelowLevel === undefined) {
        blocks.push({ kind: "heading", level, text, anchor: undefined, label: undefined });
      }
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line) ?? /^>\s?(.*)$/.exec(line);
    if (item) {
      flush();
      paragraph.push(item[1] ?? "");
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();

  const firstHeading = blocks.find((block) => block.kind === "heading");
  return {
    canonicalUrl: new URL(url).toString(),
    title: firstHeading?.text ?? url,
    language: "es",
    blocks,
  };
}

function inline(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, "$2"),
  );
}
