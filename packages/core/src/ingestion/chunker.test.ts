import { describe, expect, it } from "vitest";
import { SITE } from "../../test/support/fixtures.ts";
import { sha256Hex } from "../lib/hash.ts";
import { estimateTokens } from "../lib/text.ts";
import { chunkDocument } from "./chunker.ts";
import { dedupeChunks } from "./dedupe.ts";
import { extractHtml } from "./extract-html.ts";
import { extractMarkdown } from "./extract-markdown.ts";
import type { ExtractedDocument } from "./types.ts";

const OPTIONS = { targetTokens: 220, maxTokens: 400, overlapTokens: 40 };

function doc(blocks: ExtractedDocument["blocks"]): ExtractedDocument {
  return { canonicalUrl: "https://e.com/", title: "Doc", language: "es", blocks };
}

describe("chunkDocument on the real home page", () => {
  const chunks = chunkDocument(extractHtml(SITE.homeHtml(), SITE.homeUrl), OPTIONS);

  it("makes one chunk per office, pathology and FAQ answer", () => {
    expect(chunks).toHaveLength(22);
    const paths = chunks.map((chunk) => chunk.headingPath.slice(1).join(" › "));
    expect(paths).toContain("Consultorios › Boulogne");
    expect(paths).toContain("Patologías y tratamientos › Infiltraciones");
    expect(paths.filter((path) => path.startsWith("Preguntas frecuentes ›"))).toHaveLength(8);
  });

  it("starts every chunk with its heading path and links to the section", () => {
    const boulogne = chunks.find((chunk) => chunk.anchorUrl.endsWith("#consultorio-boulogne"));
    expect(boulogne?.content.split("\n")[0]).toBe(
      "Dr. Luis Antonio Ghilino › Consultorios › Boulogne",
    );
    expect(boulogne?.content).toContain("Sábados de 10 a 12 h");
    expect(boulogne?.searchText).toContain("vertiz"); // folded for the lexical index
  });

  it("stays within the token ceiling and numbers chunks in order", () => {
    chunks.forEach((chunk, i) => {
      expect(chunk.ordinal).toBe(i);
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(OPTIONS.maxTokens);
      expect(chunk.tokenEstimate).toBe(estimateTokens(chunk.content));
    });
  });
});

describe("chunkDocument splitting", () => {
  const sentence = (i: number) =>
    `La oración número ${i} explica un detalle distinto del tratamiento.`;
  const long = doc([
    { kind: "heading", level: 2, text: "Guía", anchor: "guia", label: undefined },
    ...Array.from({ length: 60 }, (_, i) => ({ kind: "text" as const, text: sentence(i) })),
  ]);

  it("splits a long section into pieces near the target size", () => {
    const chunks = chunkDocument(long, OPTIONS);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(OPTIONS.targetTokens + 5);
      expect(chunk.content.startsWith("Guía\n")).toBe(true);
      expect(chunk.anchorUrl).toBe("https://e.com/#guia");
    }
  });

  it("repeats the tail of one piece at the start of the next", () => {
    const [first, second] = chunkDocument(long, OPTIONS);
    const lastLineOfFirst = first?.content.split("\n").at(-1);
    expect(second?.content.split("\n").slice(1)).toContain(lastLineOfFirst);
  });

  it("splits one huge paragraph by sentences, then by words", () => {
    const paragraph = Array.from({ length: 80 }, (_, i) => sentence(i)).join(" ");
    const bySentence = chunkDocument(doc([{ kind: "text", text: paragraph }]), OPTIONS);
    expect(bySentence.length).toBeGreaterThan(2);
    const words = Array.from({ length: 900 }, (_, i) => `palabra${i}`).join(" ");
    const byWord = chunkDocument(doc([{ kind: "text", text: words }]), OPTIONS);
    for (const chunk of byWord) expect(chunk.tokenEstimate).toBeLessThanOrEqual(OPTIONS.maxTokens);
  });

  it("cites the configured URL when there is no anchor", () => {
    const [chunk] = chunkDocument(doc([{ kind: "text", text: "x" }]), OPTIONS, {
      citeAs: "https://drluisghilino.com.ar/",
    });
    expect(chunk?.anchorUrl).toBe("https://drluisghilino.com.ar/");
    expect(chunk?.content).toBe("Doc\nx");
  });

  it("rejects inconsistent options", () => {
    expect(() =>
      chunkDocument(long, { targetTokens: 500, maxTokens: 400, overlapTokens: 0 }),
    ).toThrow();
    expect(() =>
      chunkDocument(long, { targetTokens: 100, maxTokens: 400, overlapTokens: 100 }),
    ).toThrow();
  });
});

describe("dedupeChunks", () => {
  const chunk = (content: string) => ({
    ordinal: 0,
    headingPath: [],
    anchorUrl: "https://e.com/",
    content,
    searchText: content.toLowerCase(),
    tokenEstimate: 10,
  });

  it("drops exact duplicates and keeps the first", async () => {
    const a = chunk("Título\nAtiende los jueves desde las 17 h");
    const decisions = dedupeChunks(
      [
        { priority: 0, chunk: a, contentHash: await sha256Hex(a.content) },
        { priority: 0, chunk: a, contentHash: await sha256Hex(a.content) },
      ],
      0.8,
    );
    expect(decisions.map((d) => d.keep)).toEqual([true, false]);
    expect(decisions[1]?.reason).toBe("exact_duplicate");
  });

  it("measures coverage by more authoritative sources only", async () => {
    const page = chunk("Página\nEn San Miguel atiende los jueves desde las 17 h sin turno previo");
    const summary = chunk(
      "Resumen\nEn San Miguel atiende los jueves desde las 17 h sin turno previo",
    );
    const sameLevel = await Promise.all(
      [page, summary].map(async (c) => ({
        priority: 0,
        chunk: c,
        contentHash: await sha256Hex(c.content),
      })),
    );
    expect(dedupeChunks(sameLevel, 0.8).map((d) => d.keep)).toEqual([true, true]);
    const ranked = sameLevel.map((item, i) => ({ ...item, priority: i * 10 }));
    const decisions = dedupeChunks(ranked, 0.8);
    expect(decisions[1]).toMatchObject({ keep: false, reason: "near_duplicate", containment: 1 });
  });

  it("drops llms.txt passages the home page already covers, keeps the new ones", async () => {
    const home = chunkDocument(extractHtml(SITE.homeHtml(), SITE.homeUrl), OPTIONS);
    const llms = chunkDocument(
      extractMarkdown(SITE.llmsTxt(), SITE.llmsUrl, { excludeHeadings: ["Secciones del sitio"] }),
      OPTIONS,
    );
    const items = await Promise.all([
      ...home.map(async (c) => ({
        priority: 0,
        chunk: c,
        contentHash: await sha256Hex(c.content),
      })),
      ...llms.map(async (c) => ({
        priority: 10,
        chunk: c,
        contentHash: await sha256Hex(c.content),
      })),
    ]);
    const decisions = dedupeChunks(items, 0.8).slice(home.length);
    const kept = llms.filter((_, i) => decisions[i]?.keep).map((c) => c.headingPath.at(-1));
    expect(kept).toEqual(["Dr. Luis Ghilino", "Contacto", "Patologías y tratamientos"]);
  });
});
