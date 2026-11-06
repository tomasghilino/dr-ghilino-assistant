import { type Action, ChatApi, type ChatReply, DEFAULT_CONFIG, type WidgetConfig } from "./api.ts";
import { isActionLink, isSiteLink, opensNewTab } from "./links.ts";
import { STYLES } from "./styles.ts";

/**
 * The embeddable chat widget (Phase 6). One <script> tag on the page:
 *
 *   <script src="https://…/widget.js" data-api="https://…/functions/chat-api" defer></script>
 *
 * Rules it keeps:
 * - Everything the API or the model returns is rendered with textContent, never as HTML.
 * - Links are rendered only if they pass links.ts; anything else stays plain text.
 * - The conversation lives in memory only: a reload starts over (the server copy expires too).
 * - It works with the keyboard and a screen reader: a labelled launcher, a dialog, a live log.
 */

const ICONS = {
  chat: "M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3 0-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z",
  close: "M6 6l12 12M18 6L6 18",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  send: "M4 12l16-8-6 16-2.5-6.5z",
  whatsapp: "M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z",
  call: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  email: "M3 6h18v12H3zM3 7l9 6 9-6",
  directions:
    "M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
} as const;

type IconName = keyof typeof ICONS;

interface Options {
  api: string;
  position: "right" | "left";
  open: boolean;
}

export class ChatWidget {
  private readonly api: ChatApi;
  private readonly root: ShadowRoot;
  private config: WidgetConfig = DEFAULT_CONFIG;
  private conversationId: string | null = null;
  private busy = false;
  /** Phones: the panel covers the screen (styles.ts) and follows the visible viewport. */
  private readonly phone = window.matchMedia("(max-width: 480px)");
  private releaseViewport: (() => void) | null = null;

  private launcher!: HTMLButtonElement;
  private panel!: HTMLElement;
  private log!: HTMLElement;
  private suggestions!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private send!: HTMLButtonElement;
  private counter!: HTMLElement;
  private status!: HTMLElement;

  constructor(host: HTMLElement, options: Options) {
    this.api = new ChatApi(options.api);
    this.root = host.attachShadow({ mode: "open" });
    host.dataset.position = options.position;
    this.applyStyles();
    this.render();
    void this.api.config().then((config) => {
      this.config = config;
      this.renderTexts();
    });
    if (options.open) this.setOpen(true);
    this.phone.addEventListener("change", () => this.followViewport(this.panel.hidden === false));
  }

  private applyStyles(): void {
    // Constructable stylesheets avoid an inline <style>, which a strict CSP on the host page may block.
    if ("adoptedStyleSheets" in this.root && "replaceSync" in CSSStyleSheet.prototype) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      this.root.adoptedStyleSheets = [sheet];
    } else {
      this.root.append(el("style", {}, STYLES));
    }
  }

  private render(): void {
    const panelId = "ghilino-chat-panel";
    this.launcher = el("button", {
      class: "launcher",
      type: "button",
      "aria-label": "Abrir el asistente virtual",
      "aria-expanded": "false",
      "aria-controls": panelId,
    });
    this.launcher.append(icon("chat"));
    this.launcher.addEventListener("click", () => this.setOpen(this.panel.hidden !== false));

    this.panel = el("section", {
      class: "panel",
      id: panelId,
      role: "dialog",
      "aria-modal": "false",
      "aria-labelledby": "ghilino-chat-title",
      tabindex: "-1",
      hidden: "",
    });

    const header = el("header");
    const titles = el("div", { class: "titles" });
    titles.append(
      el("h2", { id: "ghilino-chat-title", "data-text": "title" }),
      el("p", { "data-text": "subtitle" }),
    );
    const reset = el("button", {
      class: "icon-button",
      type: "button",
      "aria-label": "Borrar conversación",
      title: "Borrar conversación",
    });
    reset.append(icon("trash"));
    reset.addEventListener("click", () => void this.reset());
    const close = el("button", {
      class: "icon-button",
      type: "button",
      "aria-label": "Cerrar el asistente",
      title: "Cerrar",
    });
    close.append(icon("close"));
    close.addEventListener("click", () => this.setOpen(false));
    header.append(titles, reset, close);

    this.log = el("div", {
      class: "log",
      role: "log",
      "aria-live": "polite",
      "aria-relevant": "additions",
      "aria-label": "Conversación",
    });
    this.suggestions = el("div", {
      class: "suggestions",
      role: "group",
      "aria-label": "Preguntas sugeridas",
    });
    this.status = el("p", { class: "sr-only", role: "status" });

    const form = el("form", { "aria-label": "Enviar una consulta" });
    const composer = el("div", { class: "composer" });
    const label = el("label", { class: "sr-only", for: "ghilino-chat-input" }, "Tu consulta");
    this.input = el("textarea", {
      id: "ghilino-chat-input",
      rows: "1",
      placeholder: "Escribí tu consulta…",
      autocomplete: "off",
      "aria-describedby": "ghilino-chat-privacy",
    });
    this.send = el("button", { class: "send", type: "submit", "aria-label": "Enviar" });
    this.send.append(icon("send"));
    composer.append(label, this.input, this.send);
    const meta = el("div", { class: "meta" });
    this.counter = el("span", { class: "counter", "aria-live": "polite" });
    meta.append(
      el("span", { id: "ghilino-chat-privacy", "data-text": "privacyNote" }),
      this.counter,
    );
    form.append(composer, meta);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit(this.input.value);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.submit(this.input.value);
      }
    });
    this.input.addEventListener("input", () => this.onInput());
    this.panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.setOpen(false);
      }
    });

    this.panel.append(header, this.log, this.status, form);
    this.root.append(this.launcher, this.panel);
    this.startConversation();
    this.onInput();
  }

  /** Texts come from /v1/config; until it answers, the defaults are shown. */
  private renderTexts(): void {
    for (const node of this.root.querySelectorAll<HTMLElement>("[data-text]")) {
      const key = node.dataset.text as keyof WidgetConfig;
      const value = this.config[key];
      if (typeof value === "string") node.textContent = value;
    }
    this.input.maxLength = this.config.maxMessageChars;
    if (!this.conversationId && !this.busy) this.startConversation();
  }

  private startConversation(): void {
    this.log.replaceChildren(
      el("p", { class: "disclosure", "data-text": "disclosure" }, this.config.disclosure),
    );
    this.appendAssistant({
      answer: this.config.greeting,
      kind: "smalltalk",
      sources: [],
      actions: [],
    });
    this.suggestions.replaceChildren(
      ...this.config.suggestions.map((text) => {
        const chip = el("button", { class: "chip", type: "button" }, text);
        chip.addEventListener("click", () => void this.submit(text));
        return chip;
      }),
    );
    this.log.append(this.suggestions);
    this.renderTextsOnly();
  }

  private renderTextsOnly(): void {
    for (const node of this.root.querySelectorAll<HTMLElement>("[data-text]")) {
      const value = this.config[node.dataset.text as keyof WidgetConfig];
      if (typeof value === "string") node.textContent = value;
    }
  }

  private setOpen(open: boolean): void {
    this.panel.hidden = !open;
    this.launcher.setAttribute("aria-expanded", String(open));
    this.launcher.setAttribute(
      "aria-label",
      open ? "Cerrar el asistente virtual" : "Abrir el asistente virtual",
    );
    this.launcher.replaceChildren(icon(open ? "close" : "chat"));
    this.followViewport(open);
    if (open) {
      // On a phone, focusing the input would pop the keyboard over the welcome text: focus the
      // dialog instead (screen readers still announce it); the keyboard opens when they tap.
      if (this.phone.matches) this.panel.focus({ preventScroll: true });
      else this.input.focus({ preventScroll: true });
      // A new conversation starts at the top (disclosure first); an ongoing one at the last message.
      if (this.log.querySelector(".message.visitor")) this.scrollToEnd();
      else this.log.scrollTop = 0;
    } else {
      this.launcher.focus();
    }
  }

  /**
   * On a phone the panel must cover what the visitor actually sees. iOS Safari keeps fixed
   * elements on the layout viewport: when the keyboard opens it pans the visible area instead, so a
   * full-height panel slid up (header off screen, the page showing below) and the input ended up
   * under the keyboard. The visual viewport is the visible area: the panel takes its size and
   * position, and the page behind does not scroll while the chat covers it.
   */
  private followViewport(open: boolean): void {
    this.releaseViewport?.();
    this.releaseViewport = null;
    if (!open || !this.phone.matches) return;
    const page = document.documentElement;
    const previousOverflow = page.style.overflow;
    page.style.overflow = "hidden";
    const viewport = window.visualViewport;
    const place = () => {
      if (!viewport) return;
      const style = this.panel.style;
      style.top = `${viewport.offsetTop}px`;
      style.left = `${viewport.offsetLeft}px`;
      style.width = `${viewport.width}px`;
      style.height = `${viewport.height}px`;
      style.bottom = "auto";
      style.right = "auto";
      // Keyboard opening: keep the latest message in sight above it.
      if (this.root.activeElement === this.input) this.scrollToEnd();
    };
    place();
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    this.releaseViewport = () => {
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
      for (const property of ["top", "left", "width", "height", "bottom", "right"]) {
        this.panel.style.removeProperty(property);
      }
      page.style.overflow = previousOverflow;
    };
  }

  private onInput(): void {
    // Grow with the text, up to the CSS max-height.
    this.input.style.height = "auto";
    this.input.style.height = `${this.input.scrollHeight}px`;
    const length = this.input.value.length;
    const max = this.config.maxMessageChars;
    this.counter.textContent = length > max * 0.8 ? `${length}/${max}` : "";
    this.counter.classList.toggle("over", length > max);
    this.send.disabled = this.busy || this.input.value.trim() === "" || length > max;
  }

  private async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (this.busy || text === "" || text.length > this.config.maxMessageChars) return;
    this.busy = true;
    this.suggestions.remove();
    this.input.value = "";
    this.onInput();
    this.appendVisitor(text);

    const typing = el("div", { class: "typing", "aria-hidden": "true" });
    typing.append(el("i"), el("i"), el("i"));
    this.log.append(typing);
    this.log.setAttribute("aria-busy", "true");
    this.status.textContent = "El asistente está escribiendo…";
    this.scrollToEnd();

    const result = await this.api.send(text, this.conversationId);
    typing.remove();
    this.log.removeAttribute("aria-busy");
    this.status.textContent = "";
    if (result.ok) {
      this.conversationId = result.reply.conversationId ?? this.conversationId;
      this.appendAssistant(result.reply);
    } else {
      this.appendError(result.message, result.actions);
    }
    this.busy = false;
    this.onInput();
    this.input.focus();
  }

  private async reset(): Promise<void> {
    if (this.busy) return;
    const id = this.conversationId;
    this.conversationId = null;
    this.startConversation();
    this.status.textContent = "Conversación borrada.";
    if (id) await this.api.reset(id);
    this.input.focus();
  }

  private appendVisitor(text: string): void {
    const message = el("div", { class: "message visitor" });
    message.append(el("div", { class: "bubble" }, text));
    message.prepend(el("span", { class: "sr-only" }, "Vos: "));
    this.log.append(message);
    this.scrollToEnd();
  }

  private appendAssistant(reply: Pick<ChatReply, "answer" | "kind" | "sources" | "actions">): void {
    const classes = ["message", "assistant"];
    if (reply.kind === "emergency") classes.push("emergency");
    const message = el("div", { class: classes.join(" ") });
    message.append(
      el("span", { class: "sr-only" }, "Asistente: "),
      el("div", { class: "bubble" }, reply.answer),
    );

    const sources = reply.sources.filter((source) => isSiteLink(source.url));
    if (sources.length > 0) {
      const box = el("div", { class: "sources" });
      const items = el("ul");
      for (const source of sources) {
        const item = el("li");
        item.append(el("a", { href: source.url }, source.title));
        items.append(item);
      }
      box.append(el("span", {}, "Fuentes del sitio"), items);
      message.append(box);
    }
    const actions = this.actionButtons(reply.actions);
    if (actions) message.append(actions);
    this.log.append(message);
    this.scrollToEnd();
  }

  private appendError(text: string, actions: Action[]): void {
    const message = el("div", { class: "message assistant error", role: "alert" });
    message.append(el("div", { class: "bubble" }, text));
    const buttons = this.actionButtons(actions);
    if (buttons) message.append(buttons);
    this.log.append(message);
    this.scrollToEnd();
  }

  private actionButtons(actions: Action[]): HTMLElement | null {
    const valid = actions.filter((action) => isActionLink(action.url));
    if (valid.length === 0) return null;
    const box = el("div", { class: "actions" });
    for (const action of valid) {
      const attrs: Record<string, string> = {
        class: action.type === "whatsapp" ? "action primary" : "action",
        href: action.url,
      };
      if (opensNewTab(action.url)) {
        attrs.target = "_blank";
        attrs.rel = "noopener noreferrer";
      }
      const link = el("a", attrs);
      const name = (["whatsapp", "call", "email", "directions"] as const).includes(action.type)
        ? action.type
        : null;
      if (name) link.append(icon(name));
      link.append(document.createTextNode(action.label));
      box.append(link);
    }
    return box;
  }

  private scrollToEnd(): void {
    requestAnimationFrame(() => {
      this.log.scrollTop = this.log.scrollHeight;
    });
  }
}

/** createElement with attributes and optional text; text always goes through textContent. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

/** Entry point: read the script tag's data attributes and mount once. */
export function mount(script: HTMLScriptElement | null): ChatWidget | null {
  const marker = "__ghilinoAssistant";
  const globals = window as unknown as Record<string, unknown>;
  if (globals[marker]) return null;
  const api = script?.dataset.api;
  if (!api) {
    console.warn("[ghilino-assistant] missing data-api on the script tag");
    return null;
  }
  const host = document.createElement("div");
  host.id = "ghilino-assistant";
  document.body.append(host);
  const widget = new ChatWidget(host, {
    api,
    position: script?.dataset.position === "left" ? "left" : "right",
    open: script?.dataset.open === "true",
  });
  globals[marker] = widget;
  return widget;
}
