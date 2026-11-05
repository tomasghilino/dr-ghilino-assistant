import { describe, expect, it } from "vitest";
import { ConfigError, ingestConfigSchema, parseConfig, serverConfigSchema } from "./env.ts";

const validServerEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  VOYAGE_API_KEY: "pa-test",
  INSFORGE_BASE_URL: "https://example.us-east.insforge.app",
  INSFORGE_API_KEY: "ik_test",
  RATE_LIMIT_SALT: "0123456789abcdef0123",
  SESSION_ENCRYPTION_KEY: btoa("x".repeat(32)),
};

describe("server configuration", () => {
  it("applies the documented defaults", () => {
    const config = parseConfig(serverConfigSchema, validServerEnv);
    expect(config.LLM_MODEL).toBe("claude-haiku-5-5");
    expect(config.LLM_EFFORT).toBe("low");
    expect(config.EMBEDDINGS_MODEL).toBe("voyage-4");
    expect(config.RETRIEVAL_TOP_K).toBe(5);
    expect(config.ALLOWED_ORIGINS).toEqual([
      "https://drluisghilino.com.ar",
      "https://www.drluisghilino.com.ar",
    ]);
  });

  it("lets the model and limits change without code changes", () => {
    const config = parseConfig(serverConfigSchema, {
      ...validServerEnv,
      LLM_MODEL: "claude-sonnet-5-5",
      RETRIEVAL_TOP_K: "8",
      ALLOWED_ORIGINS: "http://localhost:5173, https://drluisghilino.com.ar",
    });
    expect(config.LLM_MODEL).toBe("claude-sonnet-5-5");
    expect(config.RETRIEVAL_TOP_K).toBe(8);
    expect(config.ALLOWED_ORIGINS).toEqual([
      "http://localhost:5173",
      "https://drluisghilino.com.ar",
    ]);
  });

  it("names the missing variables without echoing any value", () => {
    const secret = "sk-ant-should-never-appear";
    try {
      parseConfig(serverConfigSchema, {
        ANTHROPIC_API_KEY: secret,
        SESSION_ENCRYPTION_KEY: "short",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain("INSFORGE_API_KEY");
      expect(message).toContain("SESSION_ENCRYPTION_KEY");
      expect(message).not.toContain(secret);
    }
  });

  it("requires the key that matches the chosen embeddings provider", () => {
    const { VOYAGE_API_KEY: _omitted, ...withoutVoyage } = validServerEnv;
    expect(() => parseConfig(serverConfigSchema, withoutVoyage)).toThrow(/VOYAGE_API_KEY/);
    expect(() =>
      parseConfig(serverConfigSchema, {
        ...withoutVoyage,
        EMBEDDINGS_PROVIDER: "openai-compatible",
        EMBEDDINGS_MODEL: "openai/text-embedding-3-small",
        OPENAI_COMPATIBLE_BASE_URL: "https://example.insforge.app/v1",
        OPENAI_COMPATIBLE_API_KEY: "ik_test",
      }),
    ).not.toThrow();
  });
});

describe("ingestion configuration", () => {
  it("has chunking defaults sized for short Spanish sections", () => {
    const config = parseConfig(ingestConfigSchema, validServerEnv);
    expect(config.CHUNK_TARGET_TOKENS).toBe(220);
    expect(config.CHUNK_MAX_TOKENS).toBe(400);
    expect(config.CHUNK_OVERLAP_TOKENS).toBe(40);
  });
});
