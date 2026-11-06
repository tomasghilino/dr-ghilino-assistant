import type { ContactAction } from "@ghilino/core";
import { sha256Hex } from "@ghilino/core";
import type { Context } from "hono";

/** Hosts a source link may point to: the doctor's site only. */
export const SITE_HOSTS = ["drluisghilino.com.ar"];
/** Hosts a contact button may point to (besides tel: and mailto:). */
const ACTION_HOSTS = ["wa.me", "www.google.com", "google.com"];

const MESSAGES: Record<string, { status: 400 | 403 | 413 | 429; message: string }> = {
  validation: { status: 400, message: "No pude leer el mensaje. Probá de nuevo." },
  forbidden_origin: { status: 403, message: "Origen no permitido." },
  payload_too_large: { status: 413, message: "El mensaje es demasiado largo." },
  rate_limited: {
    status: 429,
    message: "Enviaste muchos mensajes seguidos. Probá de nuevo en unos minutos.",
  },
};

export function errorResponse(c: Context, category: string, requestId: string, message?: string) {
  const known = MESSAGES[category] ?? { status: 400 as const, message: "Solicitud inválida." };
  return c.json(
    { error: { category, message: message ?? known.message }, requestId },
    known.status,
  );
}

/** Links shown as buttons: the site's WhatsApp, phone, e-mail and Google Maps only. */
export function safeActions(actions: readonly ContactAction[]): ContactAction[] {
  return actions.filter(
    (action) =>
      /^tel:\+?\d{6,15}$/.test(action.url) ||
      /^mailto:[^\s@]+@[^\s@]+$/.test(action.url) ||
      isHttpsOn(action.url, ACTION_HOSTS),
  );
}

export function isHttpsOn(value: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Compare secrets through their hashes, so the comparison time does not depend on the input. */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  if (!given) return false;
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
