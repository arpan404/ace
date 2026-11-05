import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { buildApp } from "./fixtures/app-build.ts";

/** Builds the app the browser specs launch once per run, outside every test's timeout. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), "ace-e2e-app-"));
  if (process.env.ACE_E2E_ELECTRON === "1") await buildApp(directory);
  project.provide("appBuild", directory);
  return () => rm(directory, { recursive: true, force: true });
}
