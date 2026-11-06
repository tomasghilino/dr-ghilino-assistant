import {
  ChatService,
  createAssistant,
  DailyBudget,
  type EmbeddingProvider,
  type EnvSource,
  InsforgeRestRpcClient,
  type LlmProvider,
  localPhone,
  parseConfig,
  RateLimiter,
  type RpcClient,
  SessionCipher,
  SqlMetricsSink,
  SqlSessionStore,
  serverConfigSchema,
} from "@ghilino/core";
import type { Hono } from "hono";
import { createApp } from "./app.ts";

/**
 * The composition root shared by the Node entry (local development, e2e tests) and the Deno
 * entry (InsForge function). Reads and validates the environment once, builds every adapter, and
 * returns the HTTP app. Nothing below this file reads environment variables.
 */
export async function createAppFromEnv(
  env: EnvSource,
  platform: {
    version: string;
    /** Overrides for tests: PGlite instead of InsForge, stand-ins for the model and embeddings. */
    rpc?: RpcClient;
    llm?: LlmProvider;
    embeddings?: EmbeddingProvider;
    log?: (entry: Record<string, unknown>) => void;
    /** The built widget, served at GET /widget.js. */
    widgetScript?: string;
  },
): Promise<Hono> {
  const config = parseConfig(serverConfigSchema, env);
  const rpc =
    platform.rpc ??
    new InsforgeRestRpcClient({
      baseUrl: config.INSFORGE_BASE_URL,
      apiKey: config.INSFORGE_API_KEY,
      timeoutMs: 10_000,
    });
  const assistant = createAssistant(config, {
    rpc,
    ...(platform.llm ? { llm: platform.llm } : {}),
    ...(platform.embeddings ? { embeddings: platform.embeddings } : {}),
  });
  const sessions = new SqlSessionStore(
    rpc,
    await SessionCipher.fromBase64(config.SESSION_ENCRYPTION_KEY),
    config.SESSION_TTL_MINUTES * 60,
  );
  const chat = new ChatService(
    { agent: assistant.agent, sessions },
    {
      maxMessageChars: config.MAX_MESSAGE_CHARS,
      historyTurns: config.AGENT_HISTORY_TURNS,
      emergencyText: config.SAFETY_EMERGENCY_TEXT,
      crisisText: config.SAFETY_CRISIS_TEXT,
      embeddingModel: config.EMBEDDINGS_MODEL,
    },
  );

  const ipHeader = config.CLIENT_IP_HEADER.toLowerCase();
  return createApp({
    version: platform.version,
    ...(platform.log ? { log: platform.log } : {}),
    ...(platform.widgetScript ? { widgetScript: platform.widgetScript } : {}),
    clientIp: (request) => (request.headers.get(ipHeader) ?? "").split(",")[0]?.trim() || "unknown",
    settings: {
      allowedOrigins: config.ALLOWED_ORIGINS,
      maxMessageChars: config.MAX_MESSAGE_CHARS,
      maxBodyBytes: config.MAX_BODY_BYTES,
      sessionTtlMinutes: config.SESSION_TTL_MINUTES,
      ...(config.MAINTENANCE_TOKEN ? { maintenanceToken: config.MAINTENANCE_TOKEN } : {}),
    },
    chat: {
      chat,
      limiter: new RateLimiter(rpc, {
        salt: config.RATE_LIMIT_SALT,
        perMinute: config.RATE_LIMIT_PER_MINUTE,
        perDay: config.RATE_LIMIT_PER_DAY,
      }),
      budget: new DailyBudget(rpc, config.DAILY_BUDGET_USD),
      metrics: new SqlMetricsSink(rpc),
      contact: async () => {
        const profile = await assistant.clinic.activeProfile();
        const phone = profile?.contact.phone;
        return {
          whatsappText: phone ? `por WhatsApp al ${localPhone(phone)}` : "por WhatsApp",
          actions: profile?.contact.whatsappUrl
            ? [
                {
                  type: "whatsapp",
                  label: "Escribir por WhatsApp",
                  url: profile.contact.whatsappUrl,
                },
              ]
            : [],
        };
      },
      maintenance: () => rpc.value("maintenance_cleanup", { p_metrics_days: 90 }),
    },
  });
}
