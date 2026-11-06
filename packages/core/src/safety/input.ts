import { foldForSearch } from "../lib/text.ts";

/**
 * Input safety, before any model call (docs/architecture.md §6).
 *
 * 1. Clean the text (control characters, whitespace, length).
 * 2. Emergency fast path: a message that clearly describes a life-threatening situation or a
 *    risk of self-harm gets a fixed answer pointing to emergency services, without calling the
 *    model. The patterns are deliberately narrow: "me quebré el tobillo hace un año" must still
 *    reach the assistant, which handles urgent-but-not-critical cases itself (kind "emergency").
 * 3. Redact personal data (e-mails, phone numbers, DNI/CUIL numbers) so the model and the
 *    providers never receive it. The visitor is told not to share it in the first place.
 */

export type EmergencyKind = "medical" | "self_harm";

/** Accent-folded, lowercase patterns. Each one alone is enough to trigger the fast path. */
const SELF_HARM = [
  /\bme quiero (matar|morir|suicidar)/,
  /\bquiero (morir|morirme|matarme|suicidarme)\b/,
  /\bsuicid/,
  /\bno quiero (vivir|seguir viviendo)\b/,
  /\bquitarme la vida\b/,
  /\b(lastimarme|hacerme dano|autolesion)/,
];

const MEDICAL = [
  /\bno (puedo|puede) respirar\b/,
  /\bme (falta|falto) el aire\b/,
  /\bdolor (muy )?(fuerte |intenso )?(en el |del )?pecho\b/,
  /\b(infarto|paro cardiaco|acv|derrame cerebral)\b/,
  /\b(se|me) (desmayo|desmaye|desvanecio)\b/,
  /\b(perdio|perdi) el conocimiento\b/,
  /\bconvulsi/,
  /\b(sangra|sangrando|sangro) (mucho|sin parar)\b/,
  /\b(hemorragia|sangrado abundante)\b/,
  /\b(fractura expuesta|hueso (expuesto|afuera|salido))\b/,
  /\bno (siento|puedo mover) (las piernas|la pierna|el brazo|los brazos|la mitad del cuerpo)\b/,
  /\baccidente (grave|de transito|de auto|de moto)\b/,
];

export function detectEmergency(text: string): EmergencyKind | null {
  const folded = foldForSearch(text);
  if (SELF_HARM.some((pattern) => pattern.test(folded))) return "self_harm";
  if (MEDICAL.some((pattern) => pattern.test(folded))) return "medical";
  return null;
}

export interface RedactionResult {
  text: string;
  /** How many items of each kind were removed (counts only, for metrics). */
  redactions: { email: number; phone: number; document: number };
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
// CUIT/CUIL (20-12345678-3) and DNI (12.345.678 or 12345678): 7 or 8 digits, optional dots.
const DOCUMENT = /\b(?:\d{2}-\d{7,8}-\d|\d{1,2}\.\d{3}\.\d{3}|\d{7,8})\b/g;
// Phone numbers: 8 or more digits with optional +, spaces, dashes or parentheses between them.
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]?\d{4}\b/g;

export function redactPersonalData(text: string): RedactionResult {
  const redactions = { email: 0, phone: 0, document: 0 };
  let result = text.replace(EMAIL, () => {
    redactions.email += 1;
    return "[correo]";
  });
  result = result.replace(DOCUMENT, () => {
    redactions.document += 1;
    return "[documento]";
  });
  result = result.replace(PHONE, (match) => {
    if (match.replace(/\D/g, "").length < 8) return match;
    redactions.phone += 1;
    return "[teléfono]";
  });
  return { text: result, redactions };
}

/** Control and invisible characters (bidi overrides, zero-width): replaced by a space. */
function isStripped(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Remove control characters (keeping newlines), collapse blank runs, trim, cap the length. */
export function cleanMessage(text: string, maxChars: number): string {
  return Array.from(text.normalize("NFC"), (char) =>
    isStripped(char.codePointAt(0) ?? 0) ? " " : char,
  )
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}
