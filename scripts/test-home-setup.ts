import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, inject } from "vitest";
import { verifyEnclosingRepository } from "./enclosing-repository-guard.ts";
import { testHomeEnvironment } from "./test-home-environment.ts";
import type { TestHomeContext } from "./test-home-global-setup.ts";

// setupFiles runs before test module evaluation. Each worker/file gets a fresh home;
// global teardown owns cleanup, after every test's process and server cleanup has run.
const context: TestHomeContext = {
  testHomeRoot: inject("testHomeRoot"),
  testRealHome: inject("testRealHome"),
  enclosingRepository: inject("enclosingRepository"),
};
const repository = context.enclosingRepository ?? undefined;
const home = mkdtempSync(
  join(context.testHomeRoot, `worker-${process.env.VITEST_POOL_ID ?? "0"}-`),
);
const env = testHomeEnvironment(home, context.testRealHome, process.env, repository?.checkouts);
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);

// Checked per file, so the failure names a file that ran while the checkout's config changed.
afterAll(() => {
  verifyEnclosingRepository(repository, expect.getState().testPath ?? "A test file");
});
