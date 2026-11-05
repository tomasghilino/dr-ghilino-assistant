import { describe, expect, it } from "vitest";
import { hmacSha256Hex, sha256Hex } from "./hash.ts";
import { estimateTokens, foldForSearch, normalizeWhitespace } from "./text.ts";

describe("text helpers", () => {
  it("folds accents and case for lexical search", () => {
    expect(foldForSearch("Virrey Vértiz 117, D'Elía — ÑANDÚ")).toBe(
      "virrey vertiz 117, d'elia — nandu",
    );
  });

  it("normalizes whitespace, including non-breaking spaces", () => {
    expect(normalizeWhitespace("  Jueves desde   las 17 h \n\n\n Sin turno ")).toBe(
      "Jueves desde las 17 h Sin turno",
    );
    expect(normalizeWhitespace("a  b\n\n\n\nc", true)).toBe("a b\n\nc");
  });

  it("estimates tokens conservatively", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hola")).toBe(2);
    expect(estimateTokens("x".repeat(360))).toBe(100);
  });
});

describe("hash helpers", () => {
  it("computes SHA-256 hex digests", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("keys identifier hashes with a secret salt", async () => {
    const a = await hmacSha256Hex("salt-one", "203.0.113.7");
    const b = await hmacSha256Hex("salt-two", "203.0.113.7");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
