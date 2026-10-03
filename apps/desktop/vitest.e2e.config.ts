import { defineConfig } from "vitest/config";

/** Electron smoke tests: opt-in (ACE_E2E_ELECTRON=1), never part of `bun run test`. */
export default defineConfig({
  test: {
    name: "desktop-e2e",
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 240_000,
    maxWorkers: 1,
  },
});
