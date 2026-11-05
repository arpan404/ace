import { defineConfig } from "vitest/config";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { fileURLToPath } from "node:url";
import webProject from "./apps/web/vitest.config.ts";
import clientReactProject from "./packages/client-react/vitest.config.ts";
import { isolateTestProject } from "./scripts/test-project-isolation.ts";
import { FailureDetailsReporter } from "./scripts/test-failure-reporter.ts";
import { TimingReporter } from "./scripts/test-timing-reporter.ts";
import { nodeOnlySuites } from "./scripts/test-tiers.ts";

/** React packages run in their own jsdom projects with their own Vite plugins. */
const react = ["apps/web/**", "packages/client-react/**"];
// This review suite owns real history workers and awaits their replies and shutdown.
// Preserve its review path while applying the process project's shared hang guards.
const historyWorkerReview = "packages/history-import/src/review.test.ts";
const browserStartupSuites = [
  "tools/real-smoke/src/browser.process.test.ts",
  "tools/web-perf/src/search-jump.process.test.ts",
  "tools/web-perf/src/live-motion.process.test.ts",
  "tools/web-perf/src/markit-policy.process.test.ts",
  "tools/web-perf/src/markit-prose-look.process.test.ts",
  "tools/web-perf/src/visualization-width.process.test.ts",
];
const historyScaleSuite = "packages/history-import/src/scale.process.test.ts";
// Release, performance and real-smoke process suites run before a release (bun run test:slow),
// not before every merge. They keep the process project's setup and deadlines.
const slowProcessSuites = [
  "tools/release/src/**/*.process.test.ts",
  "tools/web-perf/src/**/*.process.test.ts",
  "tools/real-smoke/src/**/*.process.test.ts",
  "{packages,tools,apps}/*/src/**/*.perf.process.test.ts",
];
// Under Bun, scripts/test-run.ts runs the Node-only suites in a separate pass on Node.
const onBun = "bun" in process.versions;
// Four workers by default; ACE_TEST_WORKERS raises it on machines with more cores.
const workers = Number(process.env.ACE_TEST_WORKERS) || 4;

export default defineConfig({
  test: {
    reporters: [
      "default",
      new FailureDetailsReporter(),
      // scripts/test-run.ts sets the path; plain `vitest` runs record nothing.
      new TimingReporter(
        process.env.ACE_TEST_TIMINGS_FILE,
        fileURLToPath(new URL(".", import.meta.url)),
        workers,
      ),
    ],
    maxWorkers: workers,
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
            "apps/ios/bridge/**/*.test.ts",
            "scripts/*.test.ts",
          ],
          exclude: ["**/*.process.test.ts", historyWorkerReview, "**/node_modules/**", ...react],
          maxWorkers: workers,
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
          exclude: [
            "**/node_modules/**",
            ...react,
            ...browserStartupSuites,
            historyScaleSuite,
            ...slowProcessSuites,
            ...nodeOnlySuites,
          ],
          maxWorkers: workers,
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
      ...(onBun
        ? []
        : [
            {
              test: {
                name: "node-process",
                include: nodeOnlySuites,
                exclude: ["**/node_modules/**"],
                maxWorkers: workers,
                sequence: { groupOrder: 1 },
                testTimeout: PROCESS_TEST_TIMEOUT,
                hookTimeout: PROCESS_TEST_TIMEOUT,
                globalSetup: [
                  "./scripts/test-home-global-setup.ts",
                  "./scripts/process-test-setup.ts",
                ],
                setupFiles: ["./scripts/test-home-setup.ts"],
              },
            },
          ]),
      {
        test: {
          name: "slow-process",
          include: slowProcessSuites,
          exclude: ["**/node_modules/**", ...browserStartupSuites],
          maxWorkers: workers,
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
      {
        test: {
          name: "browser-process",
          include: browserStartupSuites,
          maxWorkers: workers,
          // Browser startup follows the desktop and browser bundle-building suites.
          sequence: { groupOrder: 2 },
          testTimeout: PROCESS_TEST_TIMEOUT,
          hookTimeout: PROCESS_TEST_TIMEOUT,
          globalSetup: [
            "./scripts/test-home-global-setup.ts",
            "./tools/web-perf/src/browser-test-setup.ts",
          ],
          setupFiles: ["./scripts/test-home-setup.ts"],
        },
      },
      {
        test: {
          name: "history-scale",
          include: [historyScaleSuite],
          maxWorkers: workers,
          // The production-memory scale workload runs after fixture builds and browsers close.
          sequence: { groupOrder: 3 },
          testTimeout: PROCESS_TEST_TIMEOUT,
          hookTimeout: PROCESS_TEST_TIMEOUT,
          globalSetup: ["./scripts/test-home-global-setup.ts"],
          setupFiles: ["./scripts/test-home-setup.ts"],
        },
      },
      // Browser code: under Bun, scripts/test-run.ts runs these jsdom projects on Node.
      ...(onBun
        ? []
        : [
            isolateTestProject(webProject, fileURLToPath(new URL("./apps/web", import.meta.url))),
            isolateTestProject(
              clientReactProject,
              fileURLToPath(new URL("./packages/client-react", import.meta.url)),
            ),
          ]),
    ],
  },
});
