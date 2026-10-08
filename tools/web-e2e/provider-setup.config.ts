import { defineConfig } from "@playwright/test";

/** Only the in-page fake: no provider processes, real daemon or user home. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "provider-setup-screens.spec.ts",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:5197",
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  },
  webServer: {
    command: "bunx vite --mode fake --host 127.0.0.1 --port 5197 --strictPort",
    cwd: new URL("../../apps/web", import.meta.url).pathname,
    url: "http://127.0.0.1:5197",
    reuseExistingServer: true,
  },
});
