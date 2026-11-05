import { parseHTML } from "linkedom";
import { normalizeWhitespace } from "../lib/text.ts";
import type { Block, ExtractedDocument } from "./types.ts";

export interface HtmlExtractionOptions {
  /** CSS selector of the main content. Defaults to `main`, falling back to `body`. */
  root?: string | undefined;
  /** Extra selectors to drop, on top of the defaults below. */
  exclude?: readonly string[] | undefined;
}

/** Never content: code, media, interactive controls, navigation and decorative elements. */
const DEFAULT_EXCLUDE = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "img",
  "picture",
  "video",
  "audio",
  "canvas",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "nav",
  "[aria-hidden='true']",
  "[hidden]",
];

/** Elements whose whole text is one block, unless they contain other blocks. */
const TEXT_LEAVES = new Set(["P", "LI", "DD", "BLOCKQUOTE", "FIGCAPTION", "TD", "TH", "CAPTION"]);
const BLOCK_SELECTOR =
  "p,li,ul,ol,dl,dt,dd,h1,h2,h3,h4,h5,h6,blockquote,table,section,article,div,address,details,summary,figure,header,footer,main";
/**
 * A link is content when its nearest block container is a sentence or list item ("WhatsApp 011 …"
 * in a contact list). Anywhere else ("Cómo llegar" in a card footer) it is a call-to-action button.
 */
const INLINE_LINK_CONTAINERS = new Set([
  "P",
  "LI",
  "DD",
  "DT",
  "TD",
  "TH",
  "BLOCKQUOTE",
  "FIGCAPTION",
]);
/** Stable, human-written ids only. Framework ids like `_R_2plfjb_-titulo` change between builds. */
const STABLE_ID = /^[a-z][a-z0-9-]*$/;
const MAX_LABEL_WORDS = 8;

/** DOM node types (the numeric constants avoid depending on a global `Node`). */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

interface DomNode {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
}
interface DomElement extends DomNode {
  tagName: string;
  id: string;
  parentElement: DomElement | null;
  nextElementSibling: DomElement | null;
  closest(selector: string): DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getAttribute(name: string): string | null;
  remove(): void;
}

interface SectionFrame {
  seenHeading: boolean;
  pending: string[];
}

/**
 * Turns a web page into an ordered list of headings and text blocks.
 *
 * It keeps what a reader would read (headings, paragraphs, list items, term/definition pairs) and
 * the section ids we can link to, and drops what a reader would not: scripts, styles, images,
 * forms, buttons, call-to-action links, navigation and decorative elements.
 */
export function extractHtml(
  html: string,
  pageUrl: string,
  options: HtmlExtractionOptions = {},
): ExtractedDocument {
  const { document } = parseHTML(html);
  const doc = document as unknown as {
    title: string;
    documentElement: DomElement;
    querySelector(selector: string): DomElement | null;
  };

  const root = doc.querySelector(options.root ?? "main") ?? doc.querySelector("body");
  if (!root) throw new Error("page has no <main> or <body>");

  for (const selector of [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])]) {
    for (const element of Array.from(root.querySelectorAll(selector))) element.remove();
  }
  for (const link of Array.from(root.querySelectorAll("a"))) {
    const container = link.parentElement?.closest(BLOCK_SELECTOR);
    if (!container || !INLINE_LINK_CONTAINERS.has(container.tagName)) link.remove();
  }

  const blocks: Block[] = [];
  const frames: SectionFrame[] = [];
  /** <dd> elements already emitted together with their <dt>. */
  const consumed = new Set<DomElement>();

  const emitText = (text: string) => {
    if (!text) return;
    const frame = frames.at(-1);
    if (frame && !frame.seenHeading) frame.pending.push(text);
    else blocks.push({ kind: "text", text });
  };

  const emitHeading = (element: DomElement) => {
    const level = Number(element.tagName[1]) as 1 | 2 | 3 | 4 | 5 | 6;
    const text = textOf(element);
    if (!text) return;
    const frame = frames.at(-1);
    let label: string | undefined;
    let leftovers: string[] = [];
    if (frame && !frame.seenHeading) {
      frame.seenHeading = true;
      leftovers = frame.pending;
      frame.pending = [];
      const last = leftovers.at(-1);
      if (level > 1 && last && wordCount(last) <= MAX_LABEL_WORDS) {
        label = last;
        leftovers = leftovers.slice(0, -1);
      }
    }
    blocks.push({ kind: "heading", level, text, anchor: anchorFor(element), label });
    for (const text of leftovers) blocks.push({ kind: "text", text });
  };

  const walk = (element: DomElement) => {
    if (consumed.has(element)) return;
    const tag = element.tagName;
    if (/^H[1-6]$/.test(tag)) return emitHeading(element);
    if (tag === "DT") {
      const definition = element.nextElementSibling;
      const term = textOf(element);
      if (definition?.tagName === "DD") {
        emitText(joinTerm(term, textOf(definition)));
        consumed.add(definition);
      } else {
        emitText(term);
      }
      return;
    }
    if (TEXT_LEAVES.has(tag) && !element.querySelector(BLOCK_SELECTOR)) {
      return emitText(textOf(element));
    }

    const isSection = tag === "SECTION";
    if (isSection) frames.push({ seenHeading: false, pending: [] });
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === TEXT_NODE) emitText(normalizeWhitespace(child.textContent ?? ""));
      else if (child.nodeType === ELEMENT_NODE) walk(child as DomElement);
    }
    if (isSection) {
      const frame = frames.pop();
      for (const text of frame?.pending ?? []) blocks.push({ kind: "text", text });
    }
  };
  walk(root);

  return {
    canonicalUrl: canonicalUrl(doc, pageUrl),
    title: normalizeWhitespace(doc.title ?? "") || pageUrl,
    language: (doc.documentElement.getAttribute("lang") ?? "es").split("-")[0] ?? "es",
    blocks,
  };
}

/**
 * Readable text of an element. Text nodes are concatenated as they are (the parser may split
 * "D&#x27;Elía" into several nodes), and a space is inserted at every element boundary, because
 * pages often lay out <span>San Miguel</span><span>D'Elía 1367</span> with no whitespace between.
 */
export function textOf(element: DomNode): string {
  const pieces: string[] = [];
  const collect = (node: DomNode) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === TEXT_NODE) pieces.push(child.textContent ?? "");
      else if (child.nodeType === ELEMENT_NODE) {
        pieces.push(" ");
        collect(child);
        pieces.push(" ");
      }
    }
  };
  collect(element);
  return normalizeWhitespace(pieces.join(""))
    .replace(/\s+([,.;:!?)%])/g, "$1")
    .replace(/([¿¡(])\s+/g, "$1");
}

function anchorFor(element: DomElement): string | undefined {
  let current: DomElement | null = element;
  while (current) {
    if (current.id && STABLE_ID.test(current.id)) return current.id;
    current = current.parentElement;
  }
  return undefined;
}

function joinTerm(term: string, definition: string): string {
  if (!term) return definition;
  if (!definition) return term;
  return `${term}: ${definition}`;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** The page's canonical link when it points to the same site; otherwise the URL we fetched. */
function canonicalUrl(
  doc: { querySelector(s: string): DomElement | null },
  pageUrl: string,
): string {
  const fetched = new URL(pageUrl);
  const href = doc.querySelector("link[rel='canonical']")?.getAttribute("href");
  if (href) {
    try {
      const canonical = new URL(href, fetched);
      if (canonical.origin === fetched.origin) return withoutHash(canonical);
    } catch {
      // Malformed canonical link: fall back to the fetched URL.
    }
  }
  return withoutHash(fetched);
}

function withoutHash(url: URL): string {
  const copy = new URL(url);
  copy.hash = "";
  return copy.toString();
}
