import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { assertTestHomeIsolation } from "@ace/service";

declare module "vitest" {
  export interface ProvidedContext {
    testHomeRoot: string;
    testRealHome: string;
  }
}
export type TestHomeContext = Pick<
  import("vitest").ProvidedContext,
  "testHomeRoot" | "testRealHome"
>;

export default async function setup(project: TestProject) {
  const realHome = process.env.ACE_TEST_REAL_HOME ?? homedir();
  // Refuse an unsafe TMPDIR before even creating a fixture. Workers get private temp dirs too.
  // macOS's default /private/var/folders temp root is forbidden by project-path policy.
  const requestedBase = process.platform === "darwin" ? "/tmp" : tmpdir();
  assertTestHomeIsolation(requestedBase, realHome);
  const base = await realpath(requestedBase);
  assertTestHomeIsolation(base, realHome);
  const root = await mkdtemp(join(base, "ace-test-homes-"));
  project.provide("testHomeRoot", root);
  project.provide("testRealHome", realHome);
  return () => rm(root, { recursive: true, force: true });
}
