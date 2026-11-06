import { z } from "zod";

/**
 * Configuration is read once, validated, and passed down as a typed object. Nothing below the
 * composition root reads environment variables, which keeps the core testable and lets the
 * same code run on Deno (Deno.env) and Node (process.env).
 */

/** The database column is vector(1024); every embedding model must produce this size. */
export const EMBEDDING_DIMENSIONS = 1024;

const csv = z.string().transform((value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

const positiveInt = (fallback: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().positive().max(max).default(fallback);

export const llmConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  LLM_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  /** Thinking counts toward this cap; 2,048 leaves room for it plus a short JSON answer. */
  LLM_MAX_TOKENS: positiveInt(2048, 8192),
  LLM_TIMEOUT_MS: positiveInt(15_000, 60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Tool rounds per visitor message (ADR 0006). */
  AGENT_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(8).default(4),
  /** Wall-clock budget for one visitor message, all model and tool calls included. */
  TURN_DEADLINE_MS: positiveInt(20_000, 60_000),
  /** Previous turns (visitor + assistant pairs) kept in a session and shown to the model. */
  AGENT_HISTORY_TURNS: z.coerce.number().int().min(0).max(20).default(6),
});

const embeddingsSchema = z
  .object({
    EMBEDDINGS_PROVIDER: z.enum(["voyage", "openai-compatible"]).default("voyage"),
    EMBEDDINGS_MODEL: z.string().min(1).default("voyage-4"),
    EMBEDDINGS_TIMEOUT_MS: positiveInt(8_000, 30_000),
    EMBEDDINGS_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
    EMBEDDINGS_BATCH_SIZE: positiveInt(64, 128),
    VOYAGE_API_KEY: z.string().min(1).optional(),
    /** Keys created in MongoDB Atlas use this host; legacy Voyage keys used api.voyageai.com. */
    VOYAGE_BASE_URL: z.url().default("https://ai.mongodb.com/v1"),
    OPENAI_COMPATIBLE_BASE_URL: z.url().optional(),
    OPENAI_COMPATIBLE_API_KEY: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.EMBEDDINGS_PROVIDER === "voyage" && !env.VOYAGE_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["VOYAGE_API_KEY"], message: "required for voyage" });
    }
    if (env.EMBEDDINGS_PROVIDER === "openai-compatible") {
      if (!env.OPENAI_COMPATIBLE_BASE_URL)
        ctx.addIssue({ code: "custom", path: ["OPENAI_COMPATIBLE_BASE_URL"], message: "required" });
      if (!env.OPENAI_COMPATIBLE_API_KEY)
        ctx.addIssue({ code: "custom", path: ["OPENAI_COMPATIBLE_API_KEY"], message: "required" });
    }
  });

export const retrievalConfigSchema = z.object({
  /** Chunks handed to the model after fusion, deduplication and the token budget. */
  RETRIEVAL_TOP_K: positiveInt(5, 20),
  /** How deep the semantic and the lexical lists go before Reciprocal Rank Fusion. */
  RETRIEVAL_CANDIDATES: positiveInt(20, 100),
  RETRIEVAL_RRF_K: positiveInt(60, 1000),
  /**
   * Confidence gate (ADR 0011): below this best cosine similarity the assistant abstains instead
   * of answering. Tuned with `pnpm cli eval:retrieval`; see EVALUATION.md for the measurements.
   */
  RETRIEVAL_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.35),
  /**
   * Second way through the gate: the share of the question's terms that one chunk must contain.
   * 1 means all of them, which rescues identifiers ("virrey vertiz 117") that embeddings miss.
   */
  RETRIEVAL_MIN_LEXICAL_COVERAGE: z.coerce.number().min(0.5).max(1).default(1),
  RETRIEVAL_MAX_CONTEXT_TOKENS: positiveInt(2_000, 8_000),
  /** A result whose word 3-grams are this much inside a better-ranked result is dropped. */
  RETRIEVAL_DEDUPE_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.8),
  /** In-memory cache of query embeddings, per function instance. */
  RETRIEVAL_QUERY_CACHE_SIZE: z.coerce.number().int().min(0).max(10_000).default(256),
  RETRIEVAL_QUERY_CACHE_TTL_MS: positiveInt(600_000, 86_400_000),
});

export const databaseConfigSchema = z.object({
  INSFORGE_BASE_URL: z.url(),
  /** Admin key (ik_...). Server-side only: bypasses RLS. */
  INSFORGE_API_KEY: z.string().min(1),
});

const httpSchema = z.object({
  ALLOWED_ORIGINS: csv.default([
    "https://drluisghilino.com.ar",
    "https://www.drluisghilino.com.ar",
  ]),
  MAX_MESSAGE_CHARS: positiveInt(800, 4_000),
  MAX_BODY_BYTES: positiveInt(8_192, 65_536),
  /** Secret salt for hashing IPs before they are used as rate-limit keys. */
  RATE_LIMIT_SALT: z.string().min(16),
  RATE_LIMIT_PER_MINUTE: positiveInt(8, 1_000),
  RATE_LIMIT_PER_DAY: positiveInt(60, 100_000),
  /** Global circuit breaker: once reached, the API answers with contact details only. */
  DAILY_BUDGET_USD: z.coerce.number().positive().default(2),
});

const sessionSchema = z.object({
  /** 32 random bytes, base64. Generate with `openssl rand -base64 32`. */
  SESSION_ENCRYPTION_KEY: z
    .string()
    .refine((value) => decodedLength(value) === 32, "must be 32 bytes, base64-encoded"),
  SESSION_TTL_MINUTES: positiveInt(30, 24 * 60),
});

export const safetyConfigSchema = z.object({
  /**
   * Random code placed in the system prompt; an answer that contains it is discarded (prompt-leak
   * canary). Set it as a secret so every function instance shares one system prompt and the
   * provider cache; when unset, each instance draws its own. Generate: `openssl rand -hex 8`.
   */
  SAFETY_PROMPT_CANARY: z
    .string()
    .regex(/^[A-Za-z0-9-]{8,64}$/)
    .optional(),
  SAFETY_EMERGENCY_TEXT: z
    .string()
    .min(1)
    .default(
      "Si es una emergencia, llamá ya al 107 (emergencias médicas) o al 911, o andá a la guardia más cercana. Este asistente no puede evaluar urgencias.",
    ),
  /**
   * Shown, without calling the model, when a message suggests a risk of self-harm. The 135 line
   * (Centro de Asistencia al Suicida) is free from CABA and GBA; it is not staffed 24 hours, so 911
   * comes first for immediate risk. To be confirmed by the practice before production.
   */
  SAFETY_CRISIS_TEXT: z
    .string()
    .min(1)
    .default(
      "Si estás pensando en hacerte daño, no estás solo/a: si hay riesgo inmediato llamá al 911. También podés llamar al Centro de Asistencia al Suicida, 135 (gratis desde CABA y GBA) o (011) 5275-1135 desde todo el país. Este asistente no puede ayudarte con esto, pero esas líneas sí.",
    ),
});

export const serverConfigSchema = z
  .object({ APP_ENV: z.enum(["development", "test", "production"]).default("development") })
  .and(llmConfigSchema)
  .and(embeddingsSchema)
  .and(retrievalConfigSchema)
  .and(databaseConfigSchema)
  .and(httpSchema)
  .and(sessionSchema)
  .and(safetyConfigSchema);

/** Ingestion settings that need no credentials (enough for a dry run). */
export const ingestionSettingsSchema = z.object({
  CHUNK_TARGET_TOKENS: positiveInt(220, 1_000),
  CHUNK_MAX_TOKENS: positiveInt(400, 2_000),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(200).default(40),
  INGEST_USER_AGENT: z
    .string()
    .default("DrGhilinoAssistantIngest/0.1 (+https://drluisghilino.com.ar)"),
  INGEST_SOURCES_FILE: z.string().min(1).default("knowledge/sources.json"),
  INGEST_FETCH_TIMEOUT_MS: positiveInt(15_000, 60_000),
  INGEST_MAX_BYTES: positiveInt(2_000_000, 20_000_000),
  /** Share of a chunk already covered by more authoritative sources at which it is dropped. */
  DEDUPE_CONTAINMENT_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.8),
});

export const ingestConfigSchema = ingestionSettingsSchema
  .and(embeddingsSchema)
  .and(databaseConfigSchema);

/** What `pnpm cli ask` and `pnpm cli chat` need: the agent without the HTTP layer. */
export const agentCliConfigSchema = llmConfigSchema
  .and(retrievalConfigSchema)
  .and(embeddingsSchema)
  .and(databaseConfigSchema)
  .and(safetyConfigSchema);

/** What `pnpm cli search` and `pnpm cli eval:retrieval` need: no LLM key, no HTTP secrets. */
export const retrievalCliConfigSchema = retrievalConfigSchema
  .and(embeddingsSchema)
  .and(databaseConfigSchema);

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type RetrievalConfig = z.infer<typeof retrievalConfigSchema>;
export type LlmConfig = z.infer<typeof llmConfigSchema>;
export type SafetyConfig = z.infer<typeof safetyConfigSchema>;
export type AgentCliConfig = z.infer<typeof agentCliConfigSchema>;
export type RetrievalCliConfig = z.infer<typeof retrievalCliConfigSchema>;
export type IngestConfig = z.infer<typeof ingestConfigSchema>;
export type IngestionSettings = z.infer<typeof ingestionSettingsSchema>;

export type EnvSource = Record<string, string | undefined>;

/**
 * Parse and validate. The error lists variable names and problems, never values, so it is
 * safe to log even when a secret is malformed.
 */
export function parseConfig<T extends z.ZodType>(schema: T, env: EnvSource): z.infer<T> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  throw new ConfigError(problems);
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function decodedLength(base64: string): number {
  try {
    return atob(base64).length;
  } catch {
    return -1;
  }
}
