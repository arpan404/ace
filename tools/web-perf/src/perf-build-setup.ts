import { rm } from "node:fs/promises";
import type { TestProject } from "vitest/node";
import { buildPerfApp } from "./perf-app.ts";

declare module "vitest" {
  export interface ProvidedContext {
    webPerfBuild: string;
  }
}

/**
 * Vitest global setup: the production build the browser performance suites serve, made once
 * before any of them starts, so no test spends its own time limit building the app.
 */
export default async function setup(project: TestProject) {
  const out = await buildPerfApp();
  project.provide("webPerfBuild", out);
  return async () => {
    await rm(out, { recursive: true, force: true });
  };
}
