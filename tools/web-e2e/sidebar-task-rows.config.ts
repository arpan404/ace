import { defineConfig } from "@playwright/test";
/** Isolated fake-only verification: no provider processes or personal ace home. */
export default defineConfig({
  testDir: "./e2e/fake",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5297", viewport: { width: 1440, height: 1100 } },
  webServer: {
    command: "bunx vite --mode fake --host 127.0.0.1 --port 5297 --strictPort",
    cwd: "../../apps/web",
    url: "http://127.0.0.1:5297",
    reuseExistingServer: true,
  },
});
