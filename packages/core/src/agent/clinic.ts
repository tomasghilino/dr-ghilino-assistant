import type { RpcClient } from "../db/rpc.ts";
import { type ClinicProfile, clinicProfileSchema, type Weekday } from "../domain/clinic-profile.ts";
import type { ContactAction } from "../domain/types.ts";
import type { ActionType } from "./answer.ts";

/**
 * The verified clinic facts, read through `clinic_active_profile()` and kept in memory for a few
 * minutes: they change only when an admin re-runs ingestion.
 */
export class ClinicRepository {
  private cached: { profile: ClinicProfile | null; at: number } | null = null;

  constructor(
    private readonly rpc: RpcClient,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async activeProfile(): Promise<ClinicProfile | null> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.profile;
    const row = await this.rpc.value<{ profile: unknown } | null>("clinic_active_profile");
    // A profile that no longer matches the schema is treated as missing, never half-used.
    const parsed = row ? clinicProfileSchema.safeParse(row.profile) : null;
    const profile = parsed?.success ? parsed.data : null;
    this.cached = { profile, at: this.now() };
    return profile;
  }
}

const DAY_NAMES: Record<Weekday, string> = {
  monday: "lunes",
  tuesday: "martes",
  wednesday: "miércoles",
  thursday: "jueves",
  friday: "viernes",
  saturday: "sábado",
  sunday: "domingo",
};

/** "lunes, martes y viernes desde las 18:00" / "sábado de 10:00 a 12:00". */
export function describeHours(hours: ClinicProfile["offices"][number]["hours"]): string[] {
  return hours.map((slot) => {
    const names = slot.days.map((day) => DAY_NAMES[day]);
    const days =
      names.length > 1 ? `${names.slice(0, -1).join(", ")} y ${names.at(-1)}` : (names[0] ?? "");
    return slot.closes
      ? `${days} de ${slot.opens} a ${slot.closes}`
      : `${days} desde las ${slot.opens} (el sitio no publica la hora de cierre)`;
  });
}

/** "+54 9 11 4033-6567" → "011 4033-6567", the way the site writes it. */
export function localPhone(phone: string): string {
  const match = /^\+54\s?9\s?11\s?(.+)$/.exec(phone.trim());
  return match ? `011 ${match[1]}` : phone;
}

/**
 * Contact buttons for the actions the model asked for. Links come from the verified profile,
 * never from the model. "directions" gives one button per office named in the answer, or every
 * office when the answer names none.
 */
export function buildContactActions(
  types: readonly ActionType[],
  profile: ClinicProfile | null,
  answerText: string,
): ContactAction[] {
  if (!profile) return [];
  const actions: ContactAction[] = [];
  const { contact } = profile;
  for (const type of new Set(types)) {
    if (type === "whatsapp" && contact.whatsappUrl) {
      actions.push({ type, label: "Escribir por WhatsApp", url: contact.whatsappUrl });
    } else if (type === "call" && contact.phone) {
      actions.push({ type, label: "Llamar", url: `tel:${contact.phone.replace(/[^\d+]/g, "")}` });
    } else if (type === "email" && contact.email) {
      actions.push({ type, label: "Enviar un correo", url: `mailto:${contact.email}` });
    } else if (type === "directions") {
      const named = profile.offices.filter((office) => answerText.includes(office.name));
      for (const office of named.length > 0 ? named : profile.offices) {
        if (office.mapUrl) {
          actions.push({ type, label: `Cómo llegar a ${office.name}`, url: office.mapUrl });
        }
      }
    }
  }
  return actions;
}
