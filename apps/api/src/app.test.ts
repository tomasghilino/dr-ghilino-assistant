import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

describe("HTTP app", () => {
  const app = createApp({ version: "test", now: () => new Date("2026-11-05T12:00:00Z") });

  it("reports health", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      version: "test",
      time: "2026-11-05T12:00:00.000Z",
    });
  });

  it("returns structured 404s", async () => {
    const response = await app.request("/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { category: "not_found", message: "Not found" },
    });
  });
});
