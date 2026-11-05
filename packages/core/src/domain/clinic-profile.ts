import { z } from "zod";

/**
 * Structured, verified facts about the practice, read by the clinic tools (Phase 4). Built
 * deterministically from the site's schema.org data, never by a model. A field the site does not
 * publish (closing times, insurance) is absent, and the tools say so instead of guessing.
 */

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const time = z.string().regex(/^\d{2}:\d{2}$/);

export const officeHoursSchema = z.object({
  days: z.array(z.enum(WEEKDAYS)).min(1),
  opens: time,
  closes: time.optional(),
});

export const officeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  streetAddress: z.string().min(1),
  locality: z.string().min(1),
  region: z.string().min(1),
  postalCode: z.string().optional(),
  country: z.string().min(2),
  hours: z.array(officeHoursSchema),
  /** The site's own wording for this office (appointment rules live here). */
  notes: z.string(),
  mapUrl: z.url().optional(),
  sourceUrl: z.url(),
});

export const clinicProfileSchema = z.object({
  schemaVersion: z.literal(1),
  sourceUrl: z.url(),
  doctor: z.object({
    name: z.string().min(1),
    alternateNames: z.array(z.string()),
    jobTitle: z.string().optional(),
    description: z.string(),
    license: z.string().optional(),
    education: z.array(z.string()),
    memberships: z.array(z.string()),
    topics: z.array(z.string()),
    services: z.array(z.string()),
  }),
  offices: z.array(officeSchema).min(1),
  contact: z.object({
    phone: z.string().optional(),
    whatsappUrl: z.url().optional(),
    email: z.email().optional(),
  }),
  fee: z.object({ amount: z.string() }).optional(),
});

export type OfficeHours = z.infer<typeof officeHoursSchema>;
export type Office = z.infer<typeof officeSchema>;
export type ClinicProfile = z.infer<typeof clinicProfileSchema>;
