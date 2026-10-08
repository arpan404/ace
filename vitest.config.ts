import { defineConfig } from "vitest/config";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { fileURLToPath } from "node:url";
import webProject from "./apps/web/vitest.config.ts";
import clientReactProject from "./packages/client-react/vitest.config.ts";
import { isolateTestProject } from "./scripts/test-project-isolation.ts";

/** React packages run in their own jsdom projects with their own Vite plugins. */
const react = ["apps/web/**", "packages/client-react/**"];
// This review suite owns real history workers and awaits their replies and shutdown.
// Preserve its review path while applying the process project's shared hang guards.
const historyWorkerReview = "packages/history-import/src/review.test.ts";

export default defineConfig({
  test: {
    // Bound runner overhead too: all CPU cores are usually shared with other agents.
    maxWorkers: 2,
    fsModuleCache: true,
    projects: [
      {
        test: {
          name: "unit",
          globalSetup: [
            "./scripts/test-home-global-setup.ts",
            "./tools/web-perf/src/browser-test-setup.ts",
          ],
          setupFiles: ["./scripts/test-home-setup.ts"],
          include: [
            "packages/*/src/**/*.test.ts",
            "tools/*/src/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
          ],
          exclude: ["**/*.process.test.ts", historyWorkerReview, "**/node_modules/**", ...react],
          maxWorkers: 2,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "process",
          include: [
            "{packages,tools,apps}/*/src/**/*.process.test.ts",
            "scripts/**/*.process.test.ts",
            historyWorkerReview,
          ],
          exclude: ["**/node_modules/**", ...react],
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
          testTimeout: PROCESS_TEST_TIMEOUT,
          hookTimeout: PROCESS_TEST_TIMEOUT,
          globalSetup: [
            "./scripts/test-home-global-setup.ts",
            "./scripts/process-test-setup.ts",
            "./tools/web-perf/src/browser-test-setup.ts",
          ],
          setupFiles: ["./scripts/test-home-setup.ts"],
        },
      },
      isolateTestProject(webProject, fileURLToPath(new URL("./apps/web", import.meta.url))),
      isolateTestProject(
        clientReactProject,
        fileURLToPath(new URL("./packages/client-react", import.meta.url)),
      ),
    ],
  },
});
