import type { UserWorkspaceConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const globalSetup = fileURLToPath(new URL("./test-home-global-setup.ts", import.meta.url));
const workerSetup = fileURLToPath(new URL("./test-home-setup.ts", import.meta.url));
const files = (value: string | string[] | undefined): string[] =>
  typeof value === "string" ? [value] : (value ?? []);

/** Preserve a project's plugins and hooks, with isolation preceding its own setup. */
export function isolateTestProject(
  project: UserWorkspaceConfig,
  root: string,
): UserWorkspaceConfig {
  return {
    ...project,
    root,
    test: {
      ...project.test,
      globalSetup: [globalSetup, ...files(project.test?.globalSetup)],
      setupFiles: [workerSetup, ...files(project.test?.setupFiles)],
      sequence: { ...project.test?.sequence, setupFiles: "list" },
    },
  };
}
