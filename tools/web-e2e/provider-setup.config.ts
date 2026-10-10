import { defineConfig } from "@playwright/test";

/** Only the in-page fake: no provider processes, real daemon or user home. */
const port = Number(process.env.ACE_E2E_PROVIDER_PORT ?? 5197);

export default defineConfig({
  testDir: "./e2e",
  testMatch: [
    "provider-setup-screens.spec.ts",
    "provider-account-polish.spec.ts",
    "provider-content-states.spec.ts",
  ],
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  },
  webServer: {
    command: `bunx vite --mode fake --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: new URL("../../apps/web", import.meta.url).pathname,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
  },
});
