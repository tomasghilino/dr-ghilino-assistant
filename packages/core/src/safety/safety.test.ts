import { describe, expect, it } from "vitest";
import { cleanMessage, detectEmergency, redactPersonalData } from "./input.ts";
import { guardOutput, isAllowedUrl } from "./output.ts";

describe("detectEmergency", () => {
  it.each([
    ["No puedo respirar bien y me duele el pecho", "medical"],
    ["tengo un dolor fuerte en el pecho", "medical"],
    ["mi papá se desmayó", "medical"],
    ["tuve un accidente de moto y el hueso está afuera", "medical"],
    ["está sangrando mucho la herida", "medical"],
    ["me quiero matar", "self_harm"],
    ["ya no quiero vivir", "self_harm"],
    ["pienso en el SUICIDIO", "self_harm"],
  ])("flags %j as %s", (text, kind) => {
    expect(detectEmergency(text)).toBe(kind);
  });

  it.each([
    "¿Atiende fracturas viejas? Me quebré el tobillo hace un año",
    "Me duele la rodilla cuando subo escaleras",
    "¿Cuánto cuesta la consulta?",
    "dolor de espalda crónico",
    "¿atiende accidentes de trabajo?",
  ])("leaves %j to the assistant", (text) => {
    expect(detectEmergency(text)).toBeNull();
  });
});

describe("redactPersonalData", () => {
  it("removes e-mails, phone numbers and document numbers", () => {
    const result = redactPersonalData(
      "Soy Ana, DNI 30.123.456, CUIL 27-30123456-4, mi cel es 11 5555-1234 y mi mail ana.perez@mail.com",
    );
    expect(result.text).toBe(
      "Soy Ana, DNI [documento], CUIL [documento], mi cel es [teléfono] y mi mail [correo]",
    );
    expect(result.redactions).toEqual({ email: 1, phone: 1, document: 2 });
  });

  it("keeps the numbers a question about the practice needs", () => {
    const text =
      "¿Virrey Vértiz 117 atiende a las 18 h? ¿La consulta sigue en $50.000? Matrícula 445565";
    expect(redactPersonalData(text)).toEqual({
      text,
      redactions: { email: 0, phone: 0, document: 0 },
    });
  });
});

describe("cleanMessage", () => {
  it("removes control and invisible characters, collapses blanks and caps the length", () => {
    expect(cleanMessage("  hola\u0000​  mundo\n\n\n\nchau  ", 100)).toBe("hola mundo\n\nchau");
    expect(cleanMessage("x".repeat(50), 10)).toBe("x".repeat(10));
  });
});

describe("guardOutput", () => {
  const options = { canary: "CANARY-123", allowedHosts: ["drluisghilino.com.ar"], maxChars: 60 };

  it("discards an answer that leaks the canary", () => {
    expect(guardOutput("Mi código es CANARY-123", options)).toEqual({
      text: "",
      flags: ["canary"],
      discard: true,
    });
  });

  it("removes links to hosts outside the allowlist and keeps the site's", () => {
    const result = guardOutput(
      "Mirá https://evil.example/x y https://drluisghilino.com.ar/#contacto",
      { ...options, maxChars: 500 },
    );
    expect(result.text).toBe("Mirá y https://drluisghilino.com.ar/#contacto");
    expect(result.flags).toEqual(["url_removed"]);
  });

  it("truncates a runaway answer", () => {
    const result = guardOutput("a".repeat(100), options);
    expect(result.text).toHaveLength(60);
    expect(result.flags).toEqual(["truncated"]);
  });

  it("accepts only https URLs on allowlisted hosts and their subdomains", () => {
    const hosts = ["drluisghilino.com.ar"];
    expect(isAllowedUrl("https://www.drluisghilino.com.ar/", hosts)).toBe(true);
    expect(isAllowedUrl("http://drluisghilino.com.ar/", hosts)).toBe(false);
    expect(isAllowedUrl("https://drluisghilino.com.ar.evil.example/", hosts)).toBe(false);
    expect(isAllowedUrl("javascript:alert(1)", hosts)).toBe(false);
  });
});
