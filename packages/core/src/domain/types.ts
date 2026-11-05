/** Shared vocabulary of the assistant. No behaviour here, only shapes. */

export type Channel = "web" | "whatsapp";

/** What the assistant did with a message. Drives the UI, the metrics and the evaluation. */
export const ANSWER_KINDS = [
  "answered",
  "abstained",
  "declined_medical",
  "emergency",
  "out_of_scope",
  "smalltalk",
] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

export type SourceKind = "html_page" | "jsonld" | "markdown" | "pdf" | "text" | "curated";

/** A citation shown to the visitor. `url` always points to an allowlisted, public location. */
export interface SourceRef {
  id: string;
  title: string;
  url: string;
}
