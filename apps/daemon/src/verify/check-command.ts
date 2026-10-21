import type { WorkspaceScript } from "@ace/protocol";
import { listScripts } from "../workspace-scripts.ts";

/**
 * The command Verify runs: the project's own choice, else its `check` script with its package
 * manager (package.json first, as setup scripts are chosen), else none.
 */
export function chooseCheckCommand(
  configured: string | undefined,
  scripts: readonly WorkspaceScript[],
): string | null {
  const own = configured?.trim();
  if (own) return own;
  for (const source of ["package.json", "Makefile", "justfile", "Procfile"] as const) {
    const script = scripts.find((entry) => entry.source === source && entry.name === "check");
    if (script) return script.command;
  }
  return null;
}

/** Read from the project's checkout; a manifest that can't be read offers no script. */
export async function resolveCheckCommand(
  root: string,
  configured: string | undefined,
): Promise<string | null> {
  const own = chooseCheckCommand(configured, []);
  if (own) return own;
  return chooseCheckCommand(undefined, await listScripts(root).catch(() => []));
}
