import { describe, expect, it } from "vitest";
import type { ClinicProfile } from "../domain/clinic-profile.ts";
import { parseFinalAnswer } from "./answer.ts";
import { buildContactActions, describeHours, localPhone } from "./clinic.ts";
import { buildSystemPrompt, dynamicContext } from "./prompt.ts";
import { SourceRegistry } from "./sources.ts";

const PROFILE: ClinicProfile = {
  schemaVersion: 1,
  sourceUrl: "https://drluisghilino.com.ar/",
  doctor: {
    name: "Dr. Luis Antonio Ghilino",
    alternateNames: [],
    description: "Médico traumatólogo.",
    education: [],
    memberships: [],
    topics: [],
    services: [],
  },
  offices: [
    {
      id: "consultorio-san-miguel",
      name: "San Miguel",
      streetAddress: "D'Elía 1367",
      locality: "San Miguel",
      region: "Buenos Aires",
      country: "AR",
      hours: [{ days: ["thursday"], opens: "17:00" }],
      notes: "",
      mapUrl: "https://www.google.com/maps/search/?api=1&query=San%20Miguel",
      sourceUrl: "https://drluisghilino.com.ar/#consultorio-san-miguel",
    },
    {
      id: "consultorio-boulogne",
      name: "Boulogne",
      streetAddress: "Virrey Vértiz 117",
      locality: "Boulogne",
      region: "Buenos Aires",
      country: "AR",
      hours: [
        { days: ["monday", "tuesday", "friday"], opens: "18:00" },
        { days: ["saturday"], opens: "10:00", closes: "12:00" },
      ],
      notes: "",
      mapUrl: "https://www.google.com/maps/search/?api=1&query=Boulogne",
      sourceUrl: "https://drluisghilino.com.ar/#consultorio-boulogne",
    },
  ],
  contact: {
    phone: "+54 9 11 4033-6567",
    whatsappUrl: "https://wa.me/5491140336567",
    email: "doctorghilino@gmail.com",
  },
};

describe("final answer parsing", () => {
  it("accepts the schema and rejects anything else", () => {
    const valid = { answer: "Hola", kind: "smalltalk", source_ids: [], actions: [] };
    expect(parseFinalAnswer(JSON.stringify(valid))).toEqual(valid);
    expect(parseFinalAnswer("Hola, ¿en qué te ayudo?")).toBeNull();
    expect(parseFinalAnswer(JSON.stringify({ ...valid, kind: "diagnosis" }))).toBeNull();
    expect(parseFinalAnswer(JSON.stringify({ ...valid, actions: ["open_url"] }))).toBeNull();
    expect(parseFinalAnswer(JSON.stringify({ ...valid, source_ids: ["https://x"] }))).toBeNull();
  });
});

describe("SourceRegistry", () => {
  it("numbers sources across tool calls and resolves cited ids to unique URLs", () => {
    const registry = new SourceRegistry();
    expect(registry.register("FAQ › Precio", "https://drluisghilino.com.ar/#preguntas")).toBe("S1");
    expect(registry.register("FAQ › Turnos", "https://drluisghilino.com.ar/#preguntas")).toBe("S2");
    expect(registry.register("Consultorio Boulogne", "https://drluisghilino.com.ar/#b")).toBe("S3");
    expect(registry.resolve(["S3", "S1", "S2", "S9"])).toEqual({
      sources: [
        { id: "S3", title: "Consultorio Boulogne", url: "https://drluisghilino.com.ar/#b" },
        { id: "S1", title: "FAQ › Precio", url: "https://drluisghilino.com.ar/#preguntas" },
      ],
      unknown: ["S9"],
    });
  });
});

describe("clinic helpers", () => {
  it("describes hours in Spanish and says when no closing time is published", () => {
    expect(describeHours(PROFILE.offices[1]?.hours ?? [])).toEqual([
      "lunes, martes y viernes desde las 18:00 (el sitio no publica la hora de cierre)",
      "sábado de 10:00 a 12:00",
    ]);
  });

  it("writes phone numbers the way the site does", () => {
    expect(localPhone("+54 9 11 4033-6567")).toBe("011 4033-6567");
    expect(localPhone("+54 221 555-1234")).toBe("+54 221 555-1234");
  });

  it("builds contact buttons from the profile, never from the model", () => {
    expect(buildContactActions(["whatsapp", "call", "email"], PROFILE, "")).toEqual([
      { type: "whatsapp", label: "Escribir por WhatsApp", url: "https://wa.me/5491140336567" },
      { type: "call", label: "Llamar", url: "tel:+5491140336567" },
      { type: "email", label: "Enviar un correo", url: "mailto:doctorghilino@gmail.com" },
    ]);
  });

  it("gives directions to the offices the answer names, or to all of them", () => {
    const boulogne = buildContactActions(["directions"], PROFILE, "En Boulogne atiende...");
    expect(boulogne.map((a) => a.label)).toEqual(["Cómo llegar a Boulogne"]);
    const both = buildContactActions(
      ["directions", "directions"],
      PROFILE,
      "Atiende en dos lugares",
    );
    expect(both.map((a) => a.label)).toEqual([
      "Cómo llegar a San Miguel",
      "Cómo llegar a Boulogne",
    ]);
    expect(buildContactActions(["whatsapp"], null, "")).toEqual([]);
  });
});

describe("dynamic context", () => {
  it("gives the date and time in Buenos Aires, whatever the server's time zone", () => {
    // 2026-11-06 02:30 UTC is still Thursday the 5th in Buenos Aires (UTC-3).
    expect(dynamicContext(new Date("2026-11-06T02:30:00Z"))).toMatch(
      /^Fecha y hora actual en Buenos Aires: jueves, 5 de noviembre de 2026,? 23:30\.$/,
    );
  });
});

describe("system prompt", () => {
  it("uses the search tool by default and switches the grounding rule when the site is included", () => {
    const retrieval = buildSystemPrompt({ canary: "C" });
    expect(retrieval).toContain("- search_knowledge:");
    expect(retrieval).toContain("must come from a tool result in this turn");
    expect(retrieval).not.toContain("# The website");

    const fullContext = buildSystemPrompt({
      canary: "C",
      website: [{ id: "S1", title: "FAQ", url: "https://drluisghilino.com.ar/#faq", content: "x" }],
    });
    expect(fullContext).not.toContain("- search_knowledge:");
    expect(fullContext).toContain("from the website text at the end of these instructions");
    expect(
      fullContext.endsWith(
        '<source id="S1" title="FAQ" url="https://drluisghilino.com.ar/#faq">\nx\n</source>',
      ),
    ).toBe(true);
  });
});
