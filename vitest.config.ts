import { defineConfig } from "vitest/config";

// Two projects so unit tests stay fast and integration tests (PGlite, HTTP) can be run alone.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{packages,apps}/*/{src,test}/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/node_modules/**"],
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
    ],
  },
});
