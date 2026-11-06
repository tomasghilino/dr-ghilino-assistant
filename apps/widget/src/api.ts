/** The widget's view of the HTTP API (docs/api.md). Only fields it renders are typed. */

export interface Source {
  title: string;
  url: string;
}

export interface Action {
  type: "whatsapp" | "call" | "email" | "directions";
  label: string;
  url: string;
}

export interface ChatReply {
  conversationId: string | null;
  answer: string;
  kind: string;
  sources: Source[];
  actions: Action[];
}

type ChatResult =
  | { ok: true; reply: ChatReply }
  | { ok: false; message: string; actions: Action[]; retryAfterSeconds: number | null };

export interface WidgetConfig {
  title: string;
  subtitle: string;
  greeting: string;
  disclosure: string;
  privacyNote: string;
  suggestions: string[];
  maxMessageChars: number;
  /** Contact buttons under the greeting (WhatsApp), built by the API from the verified profile. */
  actions: Action[];
}

/** Used when /v1/config cannot be reached: the widget still works, with these texts. */
export const DEFAULT_CONFIG: WidgetConfig = {
  title: "Asistente virtual",
  subtitle: "Dr. Luis Ghilino · Traumatología",
  greeting:
    "Hola, soy el asistente virtual del consultorio del Dr. Ghilino. Te ayudo con consultorios, horarios, turnos y contacto.",
  disclosure:
    "Soy un asistente virtual con inteligencia artificial. Respondo con la información publicada en este sitio y no reemplazo una consulta médica. No compartas datos personales ni de salud.",
  privacyNote:
    "Tus mensajes se procesan con servicios de inteligencia artificial de terceros. El historial se borra a los 30 minutos sin actividad.",
  suggestions: ["¿Dónde atiende?", "¿Cómo pido un turno?"],
  actions: [],
  maxMessageChars: 800,
};

const NETWORK_ERROR = "No pude conectarme. Revisá tu conexión y probá de nuevo.";

export class ChatApi {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async config(): Promise<WidgetConfig> {
    try {
      const response = await fetch(this.url("/v1/config"), {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return DEFAULT_CONFIG;
      const body = (await response.json()) as Partial<WidgetConfig>;
      return {
        title: str(body.title, DEFAULT_CONFIG.title),
        subtitle: str(body.subtitle, DEFAULT_CONFIG.subtitle),
        greeting: str(body.greeting, DEFAULT_CONFIG.greeting),
        disclosure: str(body.disclosure, DEFAULT_CONFIG.disclosure),
        privacyNote: str(body.privacyNote, DEFAULT_CONFIG.privacyNote),
        suggestions: Array.isArray(body.suggestions)
          ? body.suggestions.filter((item): item is string => typeof item === "string").slice(0, 4)
          : DEFAULT_CONFIG.suggestions,
        maxMessageChars:
          typeof body.maxMessageChars === "number"
            ? body.maxMessageChars
            : DEFAULT_CONFIG.maxMessageChars,
        actions: list<Action>(
          body.actions,
          (item) => typeof item.label === "string" && typeof item.url === "string",
        ),
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  async send(message: string, conversationId: string | null): Promise<ChatResult> {
    let response: Response;
    try {
      response = await fetch(this.url("/v1/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { ok: false, message: NETWORK_ERROR, actions: [], retryAfterSeconds: null };
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {}
    if (response.ok && typeof body.answer === "string") {
      return {
        ok: true,
        reply: {
          conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
          answer: body.answer,
          kind: typeof body.kind === "string" ? body.kind : "answered",
          sources: list<Source>(
            body.sources,
            (item) => typeof item.title === "string" && typeof item.url === "string",
          ),
          actions: list<Action>(
            body.actions,
            (item) => typeof item.label === "string" && typeof item.url === "string",
          ),
        },
      };
    }
    const error = (body.error ?? {}) as { message?: unknown };
    const retry = Number(response.headers.get("Retry-After"));
    return {
      ok: false,
      message: typeof error.message === "string" ? error.message : NETWORK_ERROR,
      actions: list<Action>(
        body.actions,
        (item) => typeof item.label === "string" && typeof item.url === "string",
      ),
      retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : null,
    };
  }

  /** "Borrar conversación". Best effort: the session expires on its own anyway. */
  async reset(conversationId: string): Promise<void> {
    try {
      await fetch(this.url(`/v1/chat/${encodeURIComponent(conversationId)}`), {
        method: "DELETE",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {}
  }

  /**
   * `data-api` is the API base. On InsForge it may need the `?path=` form (DEPLOYMENT.md): a base
   * that already has a query string gets the route in `path` instead of the URL path.
   */
  private url(route: string): string {
    const base = new URL(this.baseUrl, document.baseURI);
    if (base.search) {
      base.searchParams.set("path", route);
      return base.toString();
    }
    return `${base.toString().replace(/\/$/, "")}${route}`;
  }
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function list<T>(value: unknown, valid: (item: Record<string, unknown>) => boolean): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is T =>
      typeof item === "object" && item !== null && valid(item as Record<string, unknown>),
  );
}
