import { defineConfig } from "@playwright/test";
import { daemonHome } from "./src/real-daemon-config.ts";

const fakePort = 5190;
const realPort = 5191;
const web = new URL("../../apps/web", import.meta.url).pathname;

/**
 * End-to-end journeys through the real web app in Chromium.
 * - `fake`: the app against the in-page fake daemon (`vite --mode fake`).
 * - `real-daemon`: the app against apps/daemon with scripted providers (src/real-daemon.ts).
 * - `screens`: renders every screen in Dark and Light to /tmp/aceshots-web (run on demand).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  // The dev server compiles each route on first visit, which can be slow on a busy machine.
  expect: { timeout: 10_000 },
  use: {
    // Chromium's own user agent, so shortcuts read as they do on the machine running the tests.
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "fake",
      testMatch: /fake\/.*\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${fakePort}` },
    },
    {
      name: "real-daemon",
      testMatch: /real-daemon\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${realPort}` },
    },
    {
      name: "screens",
      testMatch: /screens\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${fakePort}` },
    },
  ],
  webServer: [
    {
      command: `bunx vite --mode fake --host 127.0.0.1 --port ${fakePort} --strictPort`,
      cwd: web,
      url: `http://127.0.0.1:${fakePort}`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `bunx vite --host 127.0.0.1 --port ${realPort} --strictPort`,
      cwd: web,
      url: `http://127.0.0.1:${realPort}`,
      reuseExistingServer: !process.env.CI,
    },
    {
      // HOME points into the throwaway daemon home so nothing reads the person's own CLI state.
      command: "node src/real-daemon.ts",
      env: { HOME: daemonHome, ACE_LOG_LEVEL: "warn" },
      wait: { stdout: /e2e daemon ready/ },
      reuseExistingServer: false,
    },
  ],
});
