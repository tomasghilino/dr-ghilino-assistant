/**
 * Intermediate shapes of the ingestion pipeline:
 * fetch → extract (Block[]) → chunk (ChunkDraft[]) → dedupe → embed → publish.
 */

export type Block =
  | {
      kind: "heading";
      level: 1 | 2 | 3 | 4 | 5 | 6;
      text: string;
      /** Element id to cite (`#consultorio-boulogne`), or the closest enclosing section id. */
      anchor: string | undefined;
      /**
       * Short "eyebrow" line that precedes the heading in the same section, e.g. "Consultorios"
       * above "Dónde y cuándo atiende". It is what visitors know the section by, so the chunker
       * uses it in the heading path.
       */
      label: string | undefined;
    }
  | { kind: "text"; text: string };

export interface ExtractedDocument {
  canonicalUrl: string;
  title: string;
  language: string;
  blocks: Block[];
}

export interface ChunkDraft {
  ordinal: number;
  headingPath: string[];
  anchorUrl: string;
  /** What is embedded and shown to the model: a heading-path line, then the section text. */
  content: string;
  /** Accent-folded, lowercased content for the lexical index. */
  searchText: string;
  tokenEstimate: number;
}
