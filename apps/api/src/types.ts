import type {
  ChatService,
  ContactAction,
  DailyBudget,
  MetricsSink,
  RateLimiter,
} from "@ghilino/core";

/** What the HTTP adapter needs from the core; built by the composition root (compose.ts). */
export interface ChatDeps {
  chat: ChatService;
  limiter: RateLimiter;
  budget: DailyBudget;
  metrics: MetricsSink;
  /** WhatsApp line and contact buttons for answers given without the model. */
  contact: () => Promise<{ whatsappText: string; actions: ContactAction[] }>;
  /** Runs `maintenance_cleanup()`; exposed only when a maintenance token is configured. */
  maintenance?: () => Promise<unknown>;
}

export interface HttpSettings {
  allowedOrigins: readonly string[];
  maxMessageChars: number;
  maxBodyBytes: number;
  /** Bearer token for POST /internal/maintenance (InsForge schedule). Unset: endpoint disabled. */
  maintenanceToken?: string;
  /** Session lifetime shown in the widget's privacy note. */
  sessionTtlMinutes: number;
}

export interface AppDeps {
  version: string;
  now?: () => Date;
  chat?: ChatDeps;
  settings?: HttpSettings;
  /** The client address as the platform reports it (used only as a rate-limit key, hashed). */
  clientIp?: (request: Request) => string;
  /** Structured, content-free logs. */
  log?: (entry: Record<string, unknown>) => void;
  /** The built widget (apps/widget/dist/widget.js), served at GET /widget.js when present. */
  widgetScript?: string;
}
