/** Collapse runs of whitespace and trim. Keeps single newlines when `keepNewlines` is true. */
export function normalizeWhitespace(text: string, keepNewlines = false): string {
  const unified = text.normalize("NFC").replace(/ /g, " ");
  if (!keepNewlines) return unified.replace(/\s+/g, " ").trim();
  return unified
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Lowercase and strip diacritics ("Vértiz" → "vertiz", "ñ" → "n").
 * Used for the lexical index and for lexical queries, so a visitor who types "Vertiz" or
 * "D'Elia" without accents still matches. Done here rather than with Postgres `unaccent`,
 * which InsForge does not document.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rough token estimate for Spanish prose. Real tokenizers differ by model (Claude's and
 * Voyage's are not the same), so chunk sizing uses this conservative estimate and the exact
 * numbers come from the APIs' usage fields. About 3.6 characters per token for Spanish.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 3.6));
}
