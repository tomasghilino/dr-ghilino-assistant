import { defineConfig } from "vitest/config";

// Unit tests stay fast; integration tests (PGlite, HTTP) and live tests (real InsForge) run apart.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{packages,apps}/*/{src,test}/**/*.test.ts"],
          exclude: [
            "**/*.int.test.ts",
            "**/*.live.test.ts",
            "**/*.e2e.test.ts",
            "**/node_modules/**",
          ],
        },
      },
      {
        test: {
          name: "integration",
          include: ["{packages,apps}/*/{src,test}/**/*.int.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        // The built widget in Chromium against the API app (PGlite, scripted model): pnpm test:e2e.
        test: {
          name: "e2e",
          include: ["apps/*/test/**/*.e2e.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Opt-in checks against the real InsForge project: LIVE=1, credentials in .env.local.
        test: {
          name: "live",
          include: ["{packages,apps}/*/{src,test}/**/*.live.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
