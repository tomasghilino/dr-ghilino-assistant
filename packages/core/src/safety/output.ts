/**
 * Output guard (docs/architecture.md §6): the last check before an answer reaches a visitor.
 *
 * - Prompt-leak canary: the system prompt holds a random code; an answer that contains it is
 *   discarded whole.
 * - Links: answers are plain text and the server adds the links (sources and contact buttons).
 *   Any URL the model writes anyway is removed unless its host is allowlisted.
 * - Length: capped, so a runaway answer cannot flood the widget.
 *
 * Citation checks live in the agent, which knows what the tools returned this turn.
 */

export type GuardFlag = "canary" | "url_removed" | "truncated";

export interface OutputGuardResult {
  text: string;
  flags: GuardFlag[];
  /** True when the whole answer must be replaced (the canary leaked). */
  discard: boolean;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/giu;

export function guardOutput(
  text: string,
  options: { canary: string; allowedHosts: readonly string[]; maxChars: number },
): OutputGuardResult {
  if (options.canary && text.includes(options.canary)) {
    return { text: "", flags: ["canary"], discard: true };
  }
  const flags: GuardFlag[] = [];
  let result = text.replace(URL_PATTERN, (match) => {
    if (isAllowedUrl(match, options.allowedHosts)) return match;
    if (!flags.includes("url_removed")) flags.push("url_removed");
    return "";
  });
  result = result.replace(/[ \t]{2,}/g, " ").trim();
  if (result.length > options.maxChars) {
    result = `${result.slice(0, options.maxChars - 1).trimEnd()}…`;
    flags.push("truncated");
  }
  return { text: result, flags, discard: false };
}

export function isAllowedUrl(value: string, allowedHosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(value.startsWith("www.") ? `https://${value}` : value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
