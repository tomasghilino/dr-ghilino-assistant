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

const llmSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  LLM_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  LLM_MAX_TOKENS: positiveInt(1024, 8192),
  LLM_TIMEOUT_MS: positiveInt(15_000, 60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
});

const embeddingsSchema = z
  .object({
    EMBEDDINGS_PROVIDER: z.enum(["voyage", "openai-compatible"]).default("voyage"),
    EMBEDDINGS_MODEL: z.string().min(1).default("voyage-4"),
    EMBEDDINGS_TIMEOUT_MS: positiveInt(8_000, 30_000),
    VOYAGE_API_KEY: z.string().min(1).optional(),
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

const retrievalSchema = z.object({
  RETRIEVAL_TOP_K: positiveInt(5, 20),
  RETRIEVAL_CANDIDATES: positiveInt(20, 100),
  RETRIEVAL_RRF_K: positiveInt(60, 1000),
  RETRIEVAL_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.35),
  RETRIEVAL_MAX_CONTEXT_TOKENS: positiveInt(2_000, 8_000),
});

const databaseSchema = z.object({
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
  TURN_DEADLINE_MS: positiveInt(20_000, 60_000),
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
  SESSION_MAX_TURNS: positiveInt(6, 20),
});

const safetySchema = z.object({
  SAFETY_EMERGENCY_TEXT: z
    .string()
    .min(1)
    .default(
      "Si es una emergencia, llamá ya al 107 (emergencias médicas) o al 911, o andá a la guardia más cercana. Este asistente no puede evaluar urgencias.",
    ),
});

export const serverConfigSchema = z
  .object({ APP_ENV: z.enum(["development", "test", "production"]).default("development") })
  .and(llmSchema)
  .and(embeddingsSchema)
  .and(retrievalSchema)
  .and(databaseSchema)
  .and(httpSchema)
  .and(sessionSchema)
  .and(safetySchema);

export const ingestConfigSchema = z
  .object({
    CHUNK_TARGET_TOKENS: positiveInt(220, 1_000),
    CHUNK_MAX_TOKENS: positiveInt(400, 2_000),
    CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(200).default(40),
    INGEST_USER_AGENT: z
      .string()
      .default("DrGhilinoAssistantIngest/0.1 (+https://drluisghilino.com.ar)"),
  })
  .and(embeddingsSchema)
  .and(databaseSchema);

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type IngestConfig = z.infer<typeof ingestConfigSchema>;

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
