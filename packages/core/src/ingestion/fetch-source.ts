export interface FetchOptions {
  fetch: typeof fetch;
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  /** Hosts we may end up on after redirects. */
  allowedHosts: ReadonlySet<string>;
}

export interface FetchedSource {
  finalUrl: string;
  contentType: string;
  body: string;
  fetchedAt: Date;
}

export class FetchSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FetchSourceError";
  }
}

const ACCEPTED_TYPES = ["text/html", "text/markdown", "text/plain", "application/xhtml+xml"];

/**
 * Downloads one allowlisted source. Defensive because it is the one place untrusted bytes enter
 * the system: https only, allowlisted hosts (also after redirects), a timeout, a size cap read
 * as a stream (a huge response is cut off, not buffered), and text content types only.
 */
export async function fetchSource(url: string, options: FetchOptions): Promise<FetchedSource> {
  const target = new URL(url);
  assertAllowed(target, options.allowedHosts);

  let response: Response;
  try {
    response = await options.fetch(target, {
      headers: { "User-Agent": options.userAgent, Accept: "text/html, text/markdown, text/plain" },
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new FetchSourceError(`could not fetch ${target.href}`, { cause: error });
  }

  const finalUrl = new URL(response.url || target.href);
  assertAllowed(finalUrl, options.allowedHosts);
  if (!response.ok) {
    await response.body?.cancel();
    throw new FetchSourceError(`${target.href} returned HTTP ${response.status}`);
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!ACCEPTED_TYPES.includes(contentType)) {
    await response.body?.cancel();
    throw new FetchSourceError(`${target.href} returned unsupported content type "${contentType}"`);
  }

  return {
    finalUrl: finalUrl.href,
    contentType,
    body: await readCapped(response, options.maxBytes, target.href),
    fetchedAt: new Date(),
  };
}

function assertAllowed(url: URL, allowedHosts: ReadonlySet<string>): void {
  if (url.protocol !== "https:") throw new FetchSourceError(`refusing non-https URL ${url.href}`);
  if (!allowedHosts.has(url.hostname)) {
    throw new FetchSourceError(`refusing host ${url.hostname}: not in the sources allowlist`);
  }
}

async function readCapped(response: Response, maxBytes: number, label: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new FetchSourceError(`${label} is larger than ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
