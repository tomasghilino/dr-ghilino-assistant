import { describe, expect, it } from "vitest";
import { clientAddress, normalizePath } from "./platform.ts";

const path = (url: string) => {
  const request = normalizePath(new Request(url), "chat-api");
  const { pathname } = new URL(request.url);
  return pathname;
};

describe("normalizePath", () => {
  it("routes the ?path= form that InsForge's project host needs", () => {
    // What the function receives for https://<project>/functions/chat-api?path=/v1/chat
    expect(path("https://x.insforge.deno.net/chat-api?path=/v1/chat")).toBe("/v1/chat");
    expect(path("https://x.insforge.deno.net/chat-api?path=/widget.js")).toBe("/widget.js");
  });

  it("also accepts hosts that pass sub-paths, with or without the prefix", () => {
    expect(path("https://x.example/functions/chat-api/v1/chat")).toBe("/v1/chat");
    expect(path("https://x.example/v1/chat")).toBe("/v1/chat");
    expect(path("https://x.example/chat-api/health")).toBe("/health");
  });

  it("ignores a path override that is not a route, and other slugs", () => {
    expect(path("https://x.example/chat-api?path=https://evil.example")).toBe("/");
    expect(path("https://x.example/chat-apix/v1/chat")).toBe("/chat-apix/v1/chat");
  });
});

describe("clientAddress", () => {
  // Measured on InsForge: a client-sent value comes first, then the visitor, then two proxies.
  const header = "203.0.113.99, 198.51.100.7, 192.0.2.10, 192.0.2.20";

  it("takes the address the trusted proxies saw, not what the client sent", () => {
    expect(clientAddress(header, 2)).toBe("198.51.100.7");
    expect(clientAddress("198.51.100.7, 192.0.2.10, 192.0.2.20", 2)).toBe("198.51.100.7");
  });

  it("uses the last entry with no trusted hops (local development)", () => {
    expect(clientAddress("203.0.113.7", 0)).toBe("203.0.113.7");
  });

  it("falls back to one shared bucket when the header is missing or too short", () => {
    expect(clientAddress(null, 2)).toBe("unknown");
    expect(clientAddress("192.0.2.10, 192.0.2.20", 2)).toBe("unknown");
  });
});
