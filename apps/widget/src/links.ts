/**
 * Which links the widget is willing to render. The API already filters them; the widget checks
 * again because it runs on the doctor's site and must never become a way to put an arbitrary link
 * (or a `javascript:` URL) in front of a visitor.
 */

const SITE_HOSTS = ["drluisghilino.com.ar", "www.drluisghilino.com.ar"];

/** A citation: a page of the doctor's site, over https. */
export function isSiteLink(value: string, extraHosts: readonly string[] = []): boolean {
  const url = parse(value);
  return (
    url !== null &&
    url.protocol === "https:" &&
    [...SITE_HOSTS, ...extraHosts].includes(url.hostname.toLowerCase())
  );
}

/** A contact button: WhatsApp, Google Maps, a phone number or an e-mail address. */
export function isActionLink(value: string): boolean {
  if (/^tel:\+?\d{6,15}$/.test(value)) return true;
  if (/^mailto:[^\s@/?#]+@[^\s@/?#]+\.[a-z]{2,}$/i.test(value)) return true;
  const url = parse(value);
  if (url === null || url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "wa.me") return true;
  return (host === "www.google.com" || host === "google.com") && url.pathname.startsWith("/maps");
}

/** Links that leave the site open in a new tab; site anchors stay in the page. */
export function opensNewTab(value: string): boolean {
  const url = parse(value);
  return url !== null && url.protocol === "https:" && !SITE_HOSTS.includes(url.hostname);
}

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
