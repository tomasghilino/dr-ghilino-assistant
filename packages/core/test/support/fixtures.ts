import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Snapshots of the live site taken on 2026-11-05, so tests do not depend on the network. */
export const SITE = {
  homeUrl: "https://drluisghilino.com.ar/",
  llmsUrl: "https://drluisghilino.com.ar/llms.txt",
  homeHtml: () => readFileSync(join(FIXTURES, "drluisghilino-home-2026-11-05.html"), "utf8"),
  llmsTxt: () => readFileSync(join(FIXTURES, "drluisghilino-llms-2026-11-05.txt"), "utf8"),
};

export interface FakeResponse {
  body: string;
  status?: number;
  contentType?: string;
}

/**
 * A `fetch` that serves fixed responses by URL and records every request. Unknown URLs fail like
 * a network error would.
 */
export function fakeFetch(routes: Record<string, FakeResponse | (() => FakeResponse)>) {
  const requests: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push(url);
    const route = routes[url];
    if (!route) throw new TypeError(`fetch failed: no route for ${url}`);
    const response = typeof route === "function" ? route() : route;
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: { "content-type": response.contentType ?? "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
  return { fetch: impl, requests };
}
