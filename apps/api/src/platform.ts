/**
 * What the hosting platform decides about a request, measured on InsForge on 2026-11-06
 * (DEPLOYMENT.md, "What the first deploy showed"). Runtime-agnostic, so it is unit-tested in Node.
 */

/**
 * Functions are invoked at `/functions/<slug>` on the project host, and the function receives the
 * path as `/<slug>`: sub-paths are not routed, so the route travels as `?path=/v1/chat`. A host that
 * does route sub-paths may pass `/functions/<slug>/v1/chat` or `/v1/chat`; all three work.
 */
export function normalizePath(request: Request, slug: string): Request {
  const url = new URL(request.url);
  let path = url.pathname;
  for (const prefix of [`/functions/${slug}`, `/${slug}`]) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      path = path.slice(prefix.length);
      break;
    }
  }
  const override = url.searchParams.get("path");
  if ((path === "" || path === "/") && override?.startsWith("/")) path = override;
  if (path === url.pathname) return request;
  url.pathname = path || "/";
  return new Request(url, request);
}

/**
 * The visitor's address from an `X-Forwarded-For`-style header. Proxies append, so the leftmost
 * entries are whatever the client sent and can be forged; the trustworthy one is `trustedHops`
 * entries from the right (the address the outermost trusted proxy saw). On InsForge's project
 * host the chain is `<client-sent…>, <visitor>, <internal LB>, <gateway>`, so `trustedHops` is 2.
 * Too few entries means the header was not set by the platform: everyone shares one bucket.
 */
export function clientAddress(header: string | null, trustedHops: number): string {
  const entries = (header ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries[entries.length - 1 - trustedHops] ?? "unknown";
}
