import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { buildApp } from "./fixtures/app-build.ts";

/**
 * Builds the app the browser specs launch once per run, outside every test's timeout. The build
 * folder goes when the run ends, when the build fails, and when the run exits mid-build (an
 * interrupted build kills Vite, so `buildApp` throws).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), "ace-e2e-app-"));
  const removeOnExit = () => rmSync(directory, { recursive: true, force: true });
  process.once("exit", removeOnExit);
  const remove = async () => {
    process.off("exit", removeOnExit);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    if (process.env.ACE_E2E_ELECTRON === "1") await buildApp(directory);
  } catch (error) {
    await remove();
    throw error;
  }
  project.provide("appBuild", directory);
  return remove;
}
