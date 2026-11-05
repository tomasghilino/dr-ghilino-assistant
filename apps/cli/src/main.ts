import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  ConfigError,
  databaseConfigSchema,
  InsforgeRpcClient,
  ingestConfigSchema,
  parseConfig,
  serverConfigSchema,
} from "@ghilino/core";
import { createAdminClient } from "@insforge/sdk";

/**
 * Admin CLI. Runs on a developer's machine or in CI, never in the public API.
 * Commands are added phase by phase: ingest (2), eval:retrieval (3), eval:agent (7), ops:report (7).
 */
const COMMANDS: Record<string, { summary: string; run: (args: string[]) => Promise<number> }> = {
  "config:check": {
    summary: "Validate the environment for the API and for ingestion (prints names, never values)",
    run: async () => {
      let failures = 0;
      for (const [label, schema] of [
        ["api", serverConfigSchema],
        ["ingest", ingestConfigSchema],
      ] as const) {
        try {
          parseConfig(schema, process.env);
          console.log(`✓ ${label} configuration is valid`);
        } catch (error) {
          if (!(error instanceof ConfigError)) throw error;
          failures += 1;
          console.log(`✗ ${label} configuration:\n  - ${error.problems.join("\n  - ")}`);
        }
      }
      return failures === 0 ? 0 : 1;
    },
  },
  "db:status": {
    summary: "Call assistant_status() on InsForge with the admin key (counts only, no content)",
    run: async () => {
      const config = parseConfig(databaseConfigSchema, process.env);
      const rpc = new InsforgeRpcClient(
        createAdminClient({
          baseUrl: config.INSFORGE_BASE_URL,
          apiKey: config.INSFORGE_API_KEY,
          timeout: 10_000,
          retryCount: 1,
        }),
      );
      console.log(JSON.stringify(await rpc.value("assistant_status"), null, 2));
      return 0;
    },
  },
};

async function main(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: false });
  const [name, ...rest] = positionals;
  const command = name ? COMMANDS[name] : undefined;
  if (!command) {
    console.log("Usage: pnpm cli <command>\n");
    for (const [commandName, { summary }] of Object.entries(COMMANDS)) {
      console.log(`  ${commandName.padEnd(16)} ${summary}`);
    }
    return name ? 1 : 0;
  }
  // Local secrets live in .env.local (git-ignored). In CI they come from the environment.
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  return command.run(rest);
}

process.exitCode = await main(process.argv.slice(2));
