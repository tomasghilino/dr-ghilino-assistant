import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakeFetch } from "../../test/support/fixtures.ts";
import { FetchSourceError, fetchSource } from "./fetch-source.ts";
import { sourcesFileSchema } from "./sources.ts";

const base = {
  userAgent: "test",
  timeoutMs: 1_000,
  maxBytes: 1_000,
  allowedHosts: new Set(["drluisghilino.com.ar"]),
};

describe("fetchSource", () => {
  it("returns the body of an allowlisted text page", async () => {
    const { fetch } = fakeFetch({ "https://drluisghilino.com.ar/": { body: "<html></html>" } });
    const page = await fetchSource("https://drluisghilino.com.ar/", { ...base, fetch });
    expect(page).toMatchObject({ body: "<html></html>", contentType: "text/html" });
  });

  it("refuses plain http and hosts outside the allowlist", async () => {
    const { fetch, requests } = fakeFetch({});
    await expect(fetchSource("http://drluisghilino.com.ar/", { ...base, fetch })).rejects.toThrow(
      /non-https/,
    );
    await expect(fetchSource("https://pastebin.com/x", { ...base, fetch })).rejects.toThrow(
      /allowlist/,
    );
    expect(requests).toEqual([]); // refused before any request
  });

  it("refuses error statuses, binary content and oversized bodies", async () => {
    const { fetch } = fakeFetch({
      "https://drluisghilino.com.ar/404": { body: "", status: 404 },
      "https://drluisghilino.com.ar/x.pdf": { body: "%PDF", contentType: "application/pdf" },
      "https://drluisghilino.com.ar/big": { body: "x".repeat(5_000) },
    });
    await expect(
      fetchSource("https://drluisghilino.com.ar/404", { ...base, fetch }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      fetchSource("https://drluisghilino.com.ar/x.pdf", { ...base, fetch }),
    ).rejects.toThrow(/content type/);
    await expect(
      fetchSource("https://drluisghilino.com.ar/big", { ...base, fetch }),
    ).rejects.toBeInstanceOf(FetchSourceError);
  });
});

describe("sources.json", () => {
  it("the committed file is valid", () => {
    const file = JSON.parse(
      readFileSync(new URL("../../../../knowledge/sources.json", import.meta.url), "utf8"),
    );
    const parsed = sourcesFileSchema.parse(file);
    expect(parsed.sources.map((source) => source.id)).toEqual(["site-home", "site-llms"]);
  });

  it("rejects duplicate ids and a second clinic-profile source", () => {
    const source = {
      id: "a",
      url: "https://e.com/",
      kind: "html_page",
      html: { clinicProfile: true },
    };
    expect(() => sourcesFileSchema.parse({ version: 1, sources: [source, source] })).toThrow(
      /duplicate id/,
    );
    expect(() =>
      sourcesFileSchema.parse({
        version: 1,
        sources: [source, { ...source, id: "b", url: "https://e.com/b" }],
      }),
    ).toThrow(/clinic profile/);
  });
});
