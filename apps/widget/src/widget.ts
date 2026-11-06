import { type Action, ChatApi, type ChatReply, DEFAULT_CONFIG, type WidgetConfig } from "./api.ts";
import { el, icon } from "./dom.ts";
import { isActionLink, isSiteLink, opensNewTab } from "./links.ts";
import { STYLES } from "./styles.ts";
import { coverVisualViewport } from "./viewport.ts";

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

interface Options {
  api: string;
  position: "right" | "left";
  open: boolean;
  /** false: the page has its own button and opens the chat through `window.ghilinoAssistant`. */
  launcher: boolean;
}

/** What a page may call when it brings its own button (`data-launcher="none"`). */
interface AssistantControls {
  open(trigger?: HTMLElement): void;
  close(): void;
  toggle(trigger?: HTMLElement): void;
  isOpen(): boolean;
}

class ChatWidget {
  private readonly api: ChatApi;
  private readonly root: ShadowRoot;
  private config: WidgetConfig = DEFAULT_CONFIG;
  private conversationId: string | null = null;
  private busy = false;
  /** The greeting message, which gets the WhatsApp button once /v1/config has answered. */
  private greeting: HTMLElement | null = null;
  /** Phones: the panel covers the screen (styles.ts) and follows the visible viewport. */
  private readonly phone = window.matchMedia("(max-width: 480px)");
  private releaseViewport: (() => void) | null = null;
  /** Where focus goes back on close when the page, not the widget, owns the button. */
  private returnFocus: HTMLElement | null = null;
  private readonly ownLauncher: boolean;

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
    this.ownLauncher = options.launcher;
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
    if (this.ownLauncher) this.root.append(this.launcher, this.panel);
    else this.root.append(this.panel);
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
    else this.addGreetingActions(); // the visitor was faster than /v1/config: keep their messages
  }

  private greetingActions(): Action[] {
    return this.config.actions.filter((action) => action.type === "whatsapp");
  }

  private addGreetingActions(): void {
    if (!this.greeting || this.greeting.querySelector(".actions")) return;
    const buttons = this.actionButtons(this.greetingActions());
    if (buttons) this.greeting.append(buttons);
  }

  private startConversation(): void {
    this.log.replaceChildren(
      el("p", { class: "disclosure", "data-text": "disclosure" }, this.config.disclosure),
    );
    // WhatsApp stays one tap away from the start: on the doctor's site the chat opens from the
    // WhatsApp button itself, and some visitors will have wanted WhatsApp.
    this.greeting = this.appendAssistant({
      answer: this.config.greeting,
      kind: "smalltalk",
      sources: [],
      actions: this.greetingActions(),
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

  /** The controls a page uses with `data-launcher="none"` (see `mount`). */
  controls(): AssistantControls {
    return {
      open: (trigger) => {
        this.returnFocus = trigger ?? null;
        this.setOpen(true);
      },
      close: () => this.setOpen(false),
      toggle: (trigger) => {
        if (this.panel.hidden === false) this.setOpen(false);
        else {
          this.returnFocus = trigger ?? null;
          this.setOpen(true);
        }
      },
      isOpen: () => this.panel.hidden === false,
    };
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
    } else if (this.ownLauncher) {
      this.launcher.focus();
    } else {
      this.returnFocus?.focus();
    }
    window.dispatchEvent(new CustomEvent("ghilino-assistant:toggle", { detail: { open } }));
  }

  private followViewport(open: boolean): void {
    this.releaseViewport?.();
    this.releaseViewport = null;
    if (!open || !this.phone.matches) return;
    this.releaseViewport = coverVisualViewport(this.panel, () => {
      // Keyboard opening: keep the latest message in sight above it.
      if (this.root.activeElement === this.input) this.scrollToEnd();
    });
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

  private appendAssistant(
    reply: Pick<ChatReply, "answer" | "kind" | "sources" | "actions">,
  ): HTMLElement {
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
    return message;
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
    launcher: script?.dataset.launcher !== "none",
  });
  globals[marker] = widget;
  // A page with its own button (data-launcher="none") opens the chat through these.
  globals.ghilinoAssistant = widget.controls();
  window.dispatchEvent(new CustomEvent("ghilino-assistant:ready"));
  return widget;
}
