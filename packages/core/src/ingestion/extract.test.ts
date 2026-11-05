import { describe, expect, it } from "vitest";
import { SITE } from "../../test/support/fixtures.ts";
import { extractClinicProfile } from "./extract-clinic-profile.ts";
import { extractHtml } from "./extract-html.ts";
import { extractMarkdown } from "./extract-markdown.ts";
import type { Block } from "./types.ts";

const texts = (blocks: Block[]) => blocks.map((block) => block.text);
const headings = (blocks: Block[]) =>
  blocks.filter((block): block is Extract<Block, { kind: "heading" }> => block.kind === "heading");

describe("extractHtml on the real home page", () => {
  const doc = extractHtml(SITE.homeHtml(), SITE.homeUrl);

  it("reads the canonical URL, title and language", () => {
    expect(doc.canonicalUrl).toBe("https://drluisghilino.com.ar/");
    expect(doc.title).toBe("Dr. Luis Ghilino | Médico traumatólogo en San Miguel y Boulogne");
    expect(doc.language).toBe("es");
  });

  it("keeps the outline, with section labels and stable anchors", () => {
    const outline = headings(doc.blocks).map((h) => [h.level, h.label ?? h.text, h.anchor]);
    expect(outline.slice(0, 3)).toEqual([
      [1, "Dr. Luis Antonio Ghilino", "hero-titulo"],
      [2, "Patologías y tratamientos", "patologias-titulo"],
      [3, "Artrosis", "patologia-artrosis"],
    ]);
    expect(outline).toContainEqual([3, "Boulogne", "consultorio-boulogne"]);
    expect(outline).toContainEqual([3, "¿Hace falta sacar turno?", "preguntas"]);
  });

  it("drops navigation, buttons, forms and call-to-action links", () => {
    const all = texts(doc.blocks).join("\n");
    for (const noise of [
      "Cómo llegar",
      "Pedir turno por WhatsApp",
      "Enviar por WhatsApp",
      "Nombre y apellido",
      "Saltar al contenido",
    ]) {
      expect(all).not.toContain(noise);
    }
  });

  it("keeps links that are part of the content and joins inline pieces readably", () => {
    const all = texts(doc.blocks);
    expect(all).toContain("WhatsApp 011 4033-6567");
    expect(all).toContain("D'Elía 1367, San Miguel");
    expect(all).toContain("Matrícula Provincial: 445565");
    expect(all.filter((text) => text === "445565")).toHaveLength(1); // the photo badge, not the <dd>
  });
});

describe("extractHtml rules", () => {
  const wrap = (body: string) =>
    `<html lang="es"><head><title>T</title></head><body><main>${body}</main></body></html>`;

  it("ignores framework-generated ids and uses the closest stable one", () => {
    const doc = extractHtml(
      wrap(`<section id="contacto"><h2 id="_R_abc_-titulo">Contacto</h2><p>x</p></section>`),
      "https://example.com/",
    );
    expect(headings(doc.blocks)[0]?.anchor).toBe("contacto");
  });

  it("uses a short line right before an h2 as its label, and leaves long ones as text", () => {
    const short = extractHtml(
      wrap(`<section><p>Consultorios</p><h2>Dónde atiende</h2></section>`),
      "https://e.com/",
    );
    expect(headings(short.blocks)[0]?.label).toBe("Consultorios");
    const long = extractHtml(
      wrap(
        `<section><p>Una línea bastante larga que no es una etiqueta de sección para nada</p><h2>Título</h2></section>`,
      ),
      "https://e.com/",
    );
    expect(headings(long.blocks)[0]?.label).toBeUndefined();
    expect(texts(long.blocks)).toContain(
      "Una línea bastante larga que no es una etiqueta de sección para nada",
    );
  });

  it("drops scripts, decorative elements and hidden content", () => {
    const doc = extractHtml(
      wrap(
        `<p>Visible<span aria-hidden="true">01</span></p><script>alert(1)</script><p hidden>oculto</p>`,
      ),
      "https://e.com/",
    );
    expect(texts(doc.blocks)).toEqual(["Visible"]);
  });

  it("does not trust a canonical link to another site", () => {
    const html = `<html><head><link rel="canonical" href="https://evil.example/"></head><body><main><p>x</p></main></body></html>`;
    expect(extractHtml(html, "https://drluisghilino.com.ar/").canonicalUrl).toBe(
      "https://drluisghilino.com.ar/",
    );
  });
});

describe("extractMarkdown", () => {
  it("reads headings, lists and quotes, strips links and emphasis", () => {
    const doc = extractMarkdown(
      "# Título\n\n> Resumen **importante**.\n\n## Contacto\n\n- [WhatsApp](https://wa.me/1): 011 1234\n- `x`\n",
      "https://e.com/llms.txt",
    );
    expect(doc.title).toBe("Título");
    expect(doc.blocks).toEqual([
      { kind: "heading", level: 1, text: "Título", anchor: undefined, label: undefined },
      { kind: "text", text: "Resumen importante." },
      { kind: "heading", level: 2, text: "Contacto", anchor: undefined, label: undefined },
      { kind: "text", text: "WhatsApp: 011 1234" },
      { kind: "text", text: "x" },
    ]);
  });

  it("skips excluded sections including their subsections", () => {
    const doc = extractMarkdown(
      "# A\ntexto\n## Secciones del sitio\n- link\n### Sub\nmás\n## B\nfin",
      "https://e.com/",
      { excludeHeadings: ["secciones del sitio"] },
    );
    expect(texts(doc.blocks)).toEqual(["A", "texto", "B", "fin"]);
  });

  it("parses the real llms.txt", () => {
    const doc = extractMarkdown(SITE.llmsTxt(), SITE.llmsUrl);
    expect(headings(doc.blocks).map((h) => h.text)).toContain("Preguntas frecuentes");
    expect(texts(doc.blocks)).toContain("Matrícula Provincial: 445565");
  });
});

describe("extractClinicProfile", () => {
  it("builds both offices, hours, contact and fee from the real JSON-LD", () => {
    const profile = extractClinicProfile(SITE.homeHtml(), SITE.homeUrl);
    expect(profile.doctor).toMatchObject({
      name: "Dr. Luis Antonio Ghilino",
      license: "Matrícula Provincial 445565",
      education: ["Universidad de Buenos Aires"],
    });
    expect(profile.offices.map((office) => [office.id, office.streetAddress])).toEqual([
      ["consultorio-san-miguel", "D'Elía 1367"],
      ["consultorio-boulogne", "Virrey Vértiz 117"],
    ]);
    const boulogne = profile.offices[1];
    expect(boulogne?.hours).toEqual([
      { days: ["monday", "tuesday", "friday"], opens: "18:00" },
      { days: ["saturday"], opens: "10:00", closes: "12:00" },
    ]);
    expect(boulogne?.sourceUrl).toBe("https://drluisghilino.com.ar/#consultorio-boulogne");
    expect(profile.contact).toEqual({
      phone: "+54 9 11 4033-6567",
      email: "doctorghilino@gmail.com",
      whatsappUrl: "https://wa.me/5491140336567",
    });
    expect(profile.fee).toEqual({ amount: "$50.000" });
  });

  it("does not invent what the site does not publish", () => {
    const profile = extractClinicProfile(SITE.homeHtml(), SITE.homeUrl);
    const weekday = profile.offices[0]?.hours[0];
    expect(weekday?.closes).toBeUndefined(); // "desde las 17 h": no closing time published
  });

  it("fails instead of returning a partial profile", () => {
    const html = `<html><body><script type="application/ld+json">{ not json</script></body></html>`;
    expect(() => extractClinicProfile(html, SITE.homeUrl)).toThrow(/IndividualPhysician/);
  });
});
