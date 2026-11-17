import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { assertTestHomeIsolation } from "@ace/service";
import {
  captureEnclosingRepository,
  verifyEnclosingRepository,
  type EnclosingRepository,
} from "./enclosing-repository-guard.ts";
import { prepareTestToolPath } from "./test-tool-path.ts";

declare module "vitest" {
  export interface ProvidedContext {
    testHomeRoot: string;
    testRealHome: string;
    testToolPath: string;
    enclosingRepository: EnclosingRepository | null;
  }
}
export type TestHomeContext = Pick<
  import("vitest").ProvidedContext,
  "testHomeRoot" | "testRealHome" | "testToolPath" | "enclosingRepository"
>;

export default async function setup(project: TestProject) {
  const realHome = process.env.ACE_TEST_REAL_HOME ?? homedir();
  // Refuse an unsafe TMPDIR before even creating a fixture. Workers get private temp dirs too.
  // macOS's default /private/var/folders temp root is forbidden by project-path policy.
  const requestedBase = process.platform === "darwin" ? "/tmp" : tmpdir();
  assertTestHomeIsolation(requestedBase, realHome);
  const base = await realpath(requestedBase);
  assertTestHomeIsolation(base, realHome);
  // Workers re-check this snapshot after every test file; teardown checks it once more.
  const repository = captureEnclosingRepository(project.config.root);
  const root = await mkdtemp(join(base, "ace-test-homes-"));
  // Test processes find only these tools on PATH: never an agent CLI or a version-manager shim.
  const toolPath = await prepareTestToolPath(join(root, "tools"), process.env);
  project.provide("testHomeRoot", root);
  project.provide("testToolPath", toolPath);
  project.provide("testRealHome", realHome);
  project.provide("enclosingRepository", repository ?? null);
  return async () => {
    try {
      verifyEnclosingRepository(repository, `The ${project.name || "test"} project`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
}
