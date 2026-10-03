import { defineConfig } from "@playwright/test";
import { daemonHome, webPort as realPort } from "./src/real-daemon-config.ts";

const fakePort = 5190;
const web = new URL("../../apps/web", import.meta.url).pathname;

/**
 * End-to-end journeys through the real web app in Chromium.
 * - `fake`: the app against the in-page fake daemon (`vite --mode fake`).
 * - `real-daemon`: the app against apps/daemon with scripted providers (src/real-daemon.ts).
 * - `real-daemon-deck`: a deck on that daemon, after the other real-daemon journeys.
 * - `screens`: renders every screen in Dark and Light to /tmp/aceshots-web (run on demand).
 * - `walkthrough`: records the core journeys to /tmp/aceshots-web/walkthrough.webm (on demand).
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
      testMatch: /real-daemon(?!-deck)[^/]*\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${realPort}` },
    },
    {
      // A deck adds a root thread and a thread per lane to the shared daemon, and its lanes'
      // worktrees as projects; it runs after the other real-daemon journeys so their thread
      // lists and default project stay as seeded.
      name: "real-daemon-deck",
      testMatch: /real-daemon-deck\.spec\.ts/,
      dependencies: ["real-daemon"],
      use: { baseURL: `http://127.0.0.1:${realPort}` },
    },
    {
      name: "screens",
      testMatch: /(?<!real-daemon-)screens\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${fakePort}` },
    },
    {
      name: "walkthrough",
      testMatch: /walkthrough\.spec\.ts/,
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
