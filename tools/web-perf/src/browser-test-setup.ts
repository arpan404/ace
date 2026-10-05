import { chromium } from "@playwright/test";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    chromiumExecutable: string;
  }
}

/** Resolve the installed executable before setupFiles redirects HOME and cache paths.
 * Browser profiles and all writable state still belong to the isolated test home.
 */
export default function setup(project: TestProject) {
  project.provide("chromiumExecutable", chromium.executablePath());
}
