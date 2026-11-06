import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createAppFromEnv } from "@ghilino/api/compose";
import {
  createTestDatabase,
  finalAnswer,
  HashingEmbeddings,
  ingestFixtures,
  ScriptedLlm,
  type ScriptStep,
  sourceIdsIn,
  type TestDatabase,
  toolUse,
} from "@ghilino/core/testing";
import { serve } from "@hono/node-server";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * End to end: the built widget (apps/widget/dist/widget.js) in Chromium, on a page served from its
 * own origin, talking over HTTP to the real API app, which runs on PGlite with the site fixtures and
 * a scripted model. Everything except the model and the embeddings is the production code path.
 * Run `pnpm --filter @ghilino/widget build` first (pnpm test:e2e does).
 */
const WIDGET_JS = readFileSync(join(import.meta.dirname, "../dist/widget.js"), "utf8");
const AXE_JS = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

describe("chat widget in Chromium", () => {
  let t: TestDatabase;
  let steps: ScriptStep[] = [];
  // The app is built once; each test gets a fresh scripted model behind this reference.
  let llm = new ScriptedLlm(steps);
  let browser: Browser;
  let page: Page;
  let pageServer: Server;
  let apiServer: ReturnType<typeof serve>;
  let pageOrigin: string;
  let apiOrigin: string;
  const deleted: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    await ingestFixtures(t, new HashingEmbeddings());

    pageServer = createServer((request, response) => {
      if (request.url?.startsWith("/widget.js")) {
        response.writeHead(200, { "Content-Type": "text/javascript" }).end(WIDGET_JS);
        return;
      }
      response
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(
          `<!doctype html><html lang="es-AR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Prueba</title></head><body><main><h1>Página de prueba</h1><p>Contenido.</p></main><script src="/widget.js" data-api="${apiOrigin}" defer></script></body></html>`,
        );
    });
    await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
    pageOrigin = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}`;

    const app = await createAppFromEnv(
      {
        ANTHROPIC_API_KEY: "sk-ant-test",
        VOYAGE_API_KEY: "pa-test",
        INSFORGE_BASE_URL: "https://example.us-east.insforge.app",
        INSFORGE_API_KEY: "ik_test",
        RATE_LIMIT_SALT: "0123456789abcdef0123",
        RATE_LIMIT_PER_MINUTE: "100",
        SESSION_ENCRYPTION_KEY: btoa("k".repeat(32)),
        RETRIEVAL_MIN_SIMILARITY: "0.2",
        ALLOWED_ORIGINS: pageOrigin,
      },
      {
        version: "e2e",
        rpc: t.rpc,
        llm: { model: "scripted-model", complete: (request) => llm.complete(request) },
        embeddings: new HashingEmbeddings(),
        log: () => {},
      },
    );
    await new Promise<void>((resolve) => {
      apiServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        apiOrigin = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    apiServer?.close();
    pageServer?.close();
    await t?.close();
  });

  beforeEach(async () => {
    steps = [];
    llm = new ScriptedLlm(steps);
    deleted.length = 0;
    page = await browser.newPage();
    page.on("request", (request) => {
      if (request.method() === "DELETE") deleted.push(request.url());
    });
    page.on("dialog", () => {
      throw new Error("a dialog opened: script injection");
    });
    await page.goto(pageOrigin);
  });

  const host = () => page.locator("#ghilino-assistant");
  const open = async () => {
    await host().getByRole("button", { name: "Abrir el asistente virtual" }).click();
    await expect.poll(() => host().getByRole("dialog").isVisible()).toBe(true);
  };
  const lastAssistant = () => host().locator(".message.assistant").last();

  it("opens an accessible dialog with the disclosure, a greeting and suggestions", async () => {
    const launcher = host().getByRole("button", { name: "Abrir el asistente virtual" });
    expect(await launcher.getAttribute("aria-expanded")).toBe("false");
    await open();
    expect(
      await host()
        .getByRole("button", { name: "Cerrar el asistente virtual" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    const dialog = host().getByRole("dialog", { name: "Asistente virtual" });
    expect(await dialog.isVisible()).toBe(true);
    expect(await dialog.locator(".disclosure").textContent()).toContain("inteligencia artificial");
    expect(
      await host().getByRole("group", { name: "Preguntas sugeridas" }).getByRole("button").count(),
    ).toBeGreaterThan(0);
    // Focus goes to the message box.
    expect(
      await page.evaluate(
        () => document.querySelector("#ghilino-assistant")?.shadowRoot?.activeElement?.id,
      ),
    ).toBe("ghilino-chat-input");
  });

  it("asks through a suggestion and shows the answer, site sources and contact buttons", async () => {
    steps.push(toolUse({ name: "get_appointment_information" }), (request) =>
      finalAnswer({
        answer: "Atiende en San Miguel (jueves) y en Boulogne (lunes, martes, viernes y sábados).",
        kind: "answered",
        source_ids: sourceIdsIn(request),
        actions: ["whatsapp", "directions"],
      }),
    );
    await open();
    await host().getByRole("button", { name: "¿Dónde atiende?" }).click();
    await expect
      .poll(() => lastAssistant().textContent(), { timeout: 10_000 })
      .toContain("Atiende en San Miguel");

    const sources = lastAssistant().locator(".sources a");
    expect(await sources.count()).toBe(2);
    expect(await sources.first().getAttribute("href")).toBe(
      "https://drluisghilino.com.ar/#consultorio-san-miguel",
    );
    const whatsapp = lastAssistant().getByRole("link", { name: "Escribir por WhatsApp" });
    expect(await whatsapp.getAttribute("href")).toBe("https://wa.me/5491140336567");
    expect(await whatsapp.getAttribute("target")).toBe("_blank");
    expect(await whatsapp.getAttribute("rel")).toBe("noopener noreferrer");
    // Suggestions disappear after the first question.
    expect(await host().getByRole("group", { name: "Preguntas sugeridas" }).count()).toBe(0);
  });

  it("renders model output as text, never as HTML", async () => {
    steps.push(
      finalAnswer({
        answer: 'Hola <img src=x onerror="alert(1)"> <script>alert(2)</script> <b>negrita</b>',
        kind: "smalltalk",
      }),
    );
    await open();
    await host().getByRole("textbox", { name: "Tu consulta" }).fill("hola");
    await host().getByRole("textbox", { name: "Tu consulta" }).press("Enter");
    await expect
      .poll(() => lastAssistant().textContent(), { timeout: 10_000 })
      .toContain("<img src=x");
    expect(await host().locator(".message img, .message script, .message b").count()).toBe(0);
  });

  it("refuses to render links that are not the site's or a known contact channel", async () => {
    await page.route(`${apiOrigin}/v1/chat`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": pageOrigin },
        body: JSON.stringify({
          conversationId: null,
          answer: "Respuesta",
          kind: "answered",
          sources: [
            { title: "Sitio", url: "https://drluisghilino.com.ar/#contacto" },
            { title: "Phishing", url: "https://evil.example/login" },
          ],
          actions: [
            { type: "whatsapp", label: "Malo", url: "javascript:alert(1)" },
            { type: "email", label: "Correo", url: "mailto:doctorghilino@gmail.com" },
          ],
        }),
      }),
    );
    await open();
    await host().getByRole("textbox", { name: "Tu consulta" }).fill("hola");
    await host().getByRole("button", { name: "Enviar" }).click();
    await expect.poll(() => lastAssistant().textContent()).toContain("Respuesta");
    const hrefs = await lastAssistant()
      .locator("a")
      .evaluateAll((links) => links.map((a) => a.getAttribute("href")));
    expect(hrefs).toEqual([
      "https://drluisghilino.com.ar/#contacto",
      "mailto:doctorghilino@gmail.com",
    ]);
  });

  it("shows API errors as an alert with the WhatsApp button", async () => {
    await page.route(`${apiOrigin}/v1/chat`, (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": pageOrigin, "Retry-After": "30" },
        body: JSON.stringify({
          error: { category: "rate_limited", message: "Enviaste muchos mensajes seguidos." },
          actions: [
            {
              type: "whatsapp",
              label: "Escribir por WhatsApp",
              url: "https://wa.me/5491140336567",
            },
          ],
        }),
      }),
    );
    await open();
    await host().getByRole("textbox", { name: "Tu consulta" }).fill("hola");
    await host().getByRole("button", { name: "Enviar" }).click();
    const alert = host().getByRole("alert");
    await expect.poll(() => alert.textContent()).toContain("Enviaste muchos mensajes seguidos.");
    expect(await alert.getByRole("link", { name: "Escribir por WhatsApp" }).count()).toBe(1);
  });

  it("works with the keyboard: Shift+Enter for a new line, Escape to close", async () => {
    steps.push(finalAnswer({ answer: "¡Hola!", kind: "smalltalk" }));
    await open();
    const box = host().getByRole("textbox", { name: "Tu consulta" });
    await box.type("hola");
    await box.press("Shift+Enter");
    await box.type("¿cómo estás?");
    expect(await box.inputValue()).toBe("hola\n¿cómo estás?");
    await box.press("Enter");
    await expect.poll(() => lastAssistant().textContent(), { timeout: 10_000 }).toContain("¡Hola!");
    await box.press("Escape");
    expect(await host().getByRole("dialog").isVisible()).toBe(false);
    expect(
      await page.evaluate(
        () => document.querySelector("#ghilino-assistant")?.shadowRoot?.activeElement?.className,
      ),
    ).toBe("launcher");
  });

  it("deletes the conversation on the server and on screen", async () => {
    steps.push(finalAnswer({ answer: "¡Hola!", kind: "smalltalk" }));
    await open();
    await host().getByRole("textbox", { name: "Tu consulta" }).fill("hola");
    await host().getByRole("button", { name: "Enviar" }).click();
    await expect
      .poll(() => host().locator(".message.visitor").count(), { timeout: 10_000 })
      .toBe(1);
    await expect.poll(() => lastAssistant().textContent(), { timeout: 10_000 }).toContain("¡Hola!");
    await host().getByRole("button", { name: "Borrar conversación" }).click();
    expect(await host().locator(".message.visitor").count()).toBe(0);
    await expect.poll(() => deleted.length).toBe(1);
    expect(deleted[0]).toMatch(/\/v1\/chat\/[0-9a-f-]{36}$/);
  });

  it("answers emergencies at once, highlighted", async () => {
    await open();
    await host().getByRole("textbox", { name: "Tu consulta" }).fill("no puedo respirar");
    await host().getByRole("button", { name: "Enviar" }).click();
    await expect
      .poll(() => host().locator(".message.emergency").count(), { timeout: 10_000 })
      .toBe(1);
    expect(await host().locator(".message.emergency").textContent()).toContain("107");
  });

  it("takes the whole screen on a phone, without motion when the visitor asks for none", async () => {
    await page.setViewportSize({ width: 375, height: 700 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open();
    const box = await host().getByRole("dialog").boundingBox();
    expect([box?.x, box?.y, box?.width, Math.round(box?.height ?? 0)]).toEqual([0, 0, 375, 700]);
  });

  // iOS Safari: when the keyboard opens, the visible area shrinks and pans, while fixed elements
  // stay on the layout viewport. Chromium has no on-screen keyboard, so a stand-in visualViewport
  // plays iOS's part (reported on an iPhone on 2026-11-06: header cut off, page showing below).
  it("follows the visible viewport on a phone when the keyboard opens, and gives it back", async () => {
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), {
        offsetTop: 0,
        offsetLeft: 0,
        width: 375,
        height: 700,
        scale: 1,
      });
      Object.defineProperty(window, "visualViewport", { value: viewport });
      (window as unknown as { keyboard: (height: number, top: number) => void }).keyboard = (
        height,
        top,
      ) => {
        viewport.height = height;
        viewport.offsetTop = top;
        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
      };
    });
    await page.setViewportSize({ width: 375, height: 700 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await open();
    const dialog = host().getByRole("dialog");
    const round = (box: { x: number; y: number; width: number; height: number } | null) =>
      [box?.x, box?.y, box?.width, box?.height].map((value) => Math.round(value ?? -1));
    expect(round(await dialog.boundingBox())).toEqual([0, 0, 375, 700]);
    // No keyboard on open: the dialog has focus, not the message box.
    expect(
      await page.evaluate(
        () => document.querySelector("#ghilino-assistant")?.shadowRoot?.activeElement?.id,
      ),
    ).toBe("ghilino-chat-panel");
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("hidden");

    // The keyboard takes 300 px and Safari pans the visible area down by 150 px.
    await page.evaluate(() =>
      (window as unknown as { keyboard: (height: number, top: number) => void }).keyboard(400, 150),
    );
    expect(round(await dialog.boundingBox())).toEqual([0, 150, 375, 400]);
    const input = await host().getByRole("textbox", { name: "Tu consulta" }).boundingBox();
    expect((input?.y ?? 0) + (input?.height ?? 0)).toBeLessThanOrEqual(550);
    expect(input?.y ?? 0).toBeGreaterThanOrEqual(150);

    await host().getByRole("button", { name: "Cerrar el asistente virtual" }).click();
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("");
  });

  it("has no serious accessibility violations (axe-core)", async () => {
    steps.push(toolUse({ name: "get_contact_information" }), (request) =>
      finalAnswer({
        answer: "Por WhatsApp al 011 4033-6567.",
        kind: "answered",
        source_ids: sourceIdsIn(request),
        actions: ["whatsapp"],
      }),
    );
    await open();
    await host().getByRole("textbox", { name: "Tu consulta" }).fill("¿cómo los contacto?");
    await host().getByRole("button", { name: "Enviar" }).click();
    await expect
      .poll(() => lastAssistant().textContent(), { timeout: 10_000 })
      .toContain("WhatsApp");
    await page.addScriptTag({ content: AXE_JS });
    const violations = await page.evaluate(async () => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              context: unknown,
              options: unknown,
            ) => Promise<{ violations: Array<{ id: string; impact: string; nodes: unknown[] }> }>;
          };
        }
      ).axe;
      const result = await axe.run(
        { include: [["#ghilino-assistant"]] },
        { resultTypes: ["violations"] },
      );
      return result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
    });
    expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
