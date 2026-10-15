import type { GitService } from "@ace/git";
import type { WorkspaceScript } from "@ace/protocol";
import type { CreationProgress } from "./creation-progress.ts";
import { listScripts } from "./workspace-scripts.ts";

export type Setup = (
  path: string,
  signal: AbortSignal | undefined,
  progress: CreationProgress | undefined,
  started: () => void,
) => Promise<void>;

/** One setup script per checkout: package.json's first, then Procfile, Makefile, justfile. */
const precedence: readonly WorkspaceScript["source"][] = [
  "package.json",
  "Procfile",
  "Makefile",
  "justfile",
];
export function setupScript(scripts: readonly WorkspaceScript[]): WorkspaceScript | undefined {
  for (const source of precedence) {
    const script = scripts.find((entry) => entry.source === source && entry.name === "setup");
    if (script) return script;
  }
  return undefined;
}

/** A checkout whose scripts can't be listed (an unsafe manifest) simply has no setup to run. */
export async function runSetupScript(
  git: Pick<GitService, "setupWorktree">,
  path: string,
  signal: AbortSignal | undefined,
  progress: CreationProgress | undefined,
  started: () => void,
): Promise<void> {
  const script = setupScript(await listScripts(path).catch(() => []));
  if (!script) return;
  signal?.throwIfAborted();
  progress?.update("setup");
  started();
  await git.setupWorktree({
    worktree: path,
    command: script.command,
    ...(signal ? { signal } : {}),
    ...(progress ? { stderr: progress.stderr } : {}),
  });
}
