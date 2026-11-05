import { parseHTML } from "linkedom";
import {
  type ClinicProfile,
  clinicProfileSchema,
  WEEKDAYS,
  type Weekday,
} from "../domain/clinic-profile.ts";

type JsonObject = Record<string, unknown>;

const PHYSICIAN_TYPES = ["IndividualPhysician", "Physician"];
const OFFICE_TYPES = ["PhysiciansOffice", "MedicalClinic", "MedicalBusiness"];

/**
 * Builds the clinic profile from a page's schema.org JSON-LD plus its WhatsApp link.
 * Deterministic: the same page always produces the same profile, and a page missing required
 * facts fails validation instead of producing a partial profile.
 */
export function extractClinicProfile(html: string, pageUrl: string): ClinicProfile {
  const { document } = parseHTML(html);
  const doc = document as unknown as {
    querySelectorAll(selector: string): ArrayLike<{
      textContent: string | null;
      getAttribute(name: string): string | null;
    }>;
  };

  const nodes: JsonObject[] = [];
  for (const script of Array.from(doc.querySelectorAll("script[type='application/ld+json']"))) {
    try {
      collectNodes(JSON.parse(script.textContent ?? ""), nodes);
    } catch {
      // A malformed block is ignored; validation below fails if required facts are missing.
    }
  }

  const physician = nodes.find((node) => hasType(node, PHYSICIAN_TYPES));
  const person = nodes.find((node) => hasType(node, ["Person"]));
  const offices = nodes.filter((node) => hasType(node, OFFICE_TYPES));
  if (!physician) throw new Error("no IndividualPhysician in the page's JSON-LD");

  const whatsapp = Array.from(doc.querySelectorAll("a[href^='https://wa.me/']"))
    .map((link) => link.getAttribute("href"))
    .find(Boolean);
  const prices = new Set(offices.map((office) => str(office.priceRange)).filter(Boolean));

  return clinicProfileSchema.parse({
    schemaVersion: 1,
    sourceUrl: pageUrl,
    doctor: {
      name: str(physician.name) ?? str(person?.name),
      alternateNames: strings(physician.alternateName),
      jobTitle: str(person?.jobTitle),
      description: str(physician.description) ?? "",
      license: str(obj(physician.hasCredential)?.name) ?? str(obj(person?.hasCredential)?.name),
      education: strings(names(person?.alumniOf)),
      memberships: strings(names(person?.memberOf)),
      topics: strings(physician.knowsAbout),
      services: strings(names(physician.availableService)),
    },
    offices: offices.map((office) => toOffice(office, pageUrl)),
    contact: {
      phone: str(physician.telephone),
      email: str(physician.email),
      whatsappUrl: whatsapp ? withoutQuery(whatsapp) : undefined,
    },
    fee: prices.size === 1 ? { amount: [...prices][0] } : undefined,
  });
}

function toOffice(office: JsonObject, pageUrl: string) {
  const address = obj(office.address) ?? {};
  const sourceUrl = new URL(str(office["@id"]) ?? str(office.url) ?? pageUrl, pageUrl).toString();
  const fragment = new URL(sourceUrl).hash.replace(/^#/, "");
  const locality = str(address.addressLocality) ?? "";
  return {
    id: fragment || slug(locality),
    name: locality || str(office.name),
    streetAddress: str(address.streetAddress),
    locality,
    region: str(address.addressRegion),
    postalCode: str(address.postalCode),
    country: str(address.addressCountry),
    hours: list(office.openingHoursSpecification).map((spec) => {
      const s = obj(spec) ?? {};
      return {
        days: strings(s.dayOfWeek)
          .map(toWeekday)
          .filter((day): day is Weekday => day !== undefined),
        opens: str(s.opens),
        closes: str(s.closes),
      };
    }),
    notes: str(office.description) ?? "",
    mapUrl: str(office.hasMap),
    sourceUrl,
  };
}

function collectNodes(value: unknown, into: JsonObject[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, into);
    return;
  }
  const node = obj(value);
  if (!node) return;
  if (Array.isArray(node["@graph"])) collectNodes(node["@graph"], into);
  if (node["@type"]) into.push(node);
}

function hasType(node: JsonObject, types: string[]): boolean {
  return strings(node["@type"]).some((type) => types.includes(type));
}

function toWeekday(value: string): Weekday | undefined {
  const day = value.split("/").at(-1)?.toLowerCase();
  return WEEKDAYS.find((weekday) => weekday === day);
}

function obj(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function strings(value: unknown): string[] {
  return list(value)
    .map(str)
    .filter((item): item is string => item !== undefined);
}

function names(value: unknown): unknown[] {
  return list(value).map((item) => obj(item)?.name ?? item);
}

function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function withoutQuery(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  return parsed.toString();
}
