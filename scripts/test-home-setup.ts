import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { inject } from "vitest";
import { testHomeEnvironment } from "./test-home-environment.ts";
import type { TestHomeContext } from "./test-home-global-setup.ts";

// setupFiles runs before test module evaluation. Each worker/file gets a fresh home;
// global teardown owns cleanup, after every test's process and server cleanup has run.
const context: TestHomeContext = {
  testHomeRoot: inject("testHomeRoot"),
  testRealHome: inject("testRealHome"),
};
const home = mkdtempSync(
  join(context.testHomeRoot, `worker-${process.env.VITEST_POOL_ID ?? "0"}-`),
);
Object.assign(process.env, testHomeEnvironment(home, context.testRealHome));
