import { defineConfig } from "@playwright/test";

const port = Number(process.env.ACE_E2E_FAKE_PORT ?? 5213);

/** Fake-only journeys: no daemon process, provider CLI or personal browser profile. */
export default defineConfig({
  testDir: "./e2e/fake",
  workers: 2,
  expect: { timeout: 10_000 },
  use: {
    browserName: "chromium",
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bunx vite --mode fake --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: new URL("../../apps/web", import.meta.url).pathname,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
