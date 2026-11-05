import { foldForSearch } from "./text.ts";

/**
 * Word 3-grams ("shingles") of a chunk's body, accent-folded. The first line of a chunk is its
 * heading path, shared by design among sibling chunks, so it is left out.
 */
export function bodyShingles(content: string): Set<string> {
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

/** Share of `part` contained in `whole` (0 when `part` is empty). */
export function containment(part: ReadonlySet<string>, whole: ReadonlySet<string>): number {
  if (part.size === 0) return 0;
  let inside = 0;
  for (const shingle of part) if (whole.has(shingle)) inside++;
  return inside / part.size;
}
