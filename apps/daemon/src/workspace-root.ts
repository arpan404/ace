import { z } from "zod";
import type { Thread } from "@ace/protocol";
const sessionRoot = z.object({
  cwd: z.string().min(1).max(4096),
  workspace_ready: z.union([z.literal(0), z.literal(1)]).default(1),
});
export interface ExecutionWorkspace {
  path: string;
  ready: boolean;
}
/** Provider session rows own execution roots. Client details never authorize filesystem I/O. */
export function executionWorkspace(
  thread: Thread,
  session: unknown,
  project: string | undefined,
): ExecutionWorkspace {
  if (thread.deletedAt !== undefined) throw new Error("thread_not_found");
  if (session !== undefined) {
    const row = sessionRoot.parse(session);
    return { path: row.cwd, ready: row.workspace_ready === 1 };
  }
  if (!project) throw new Error("workspace_not_found");
  // Imported/dev threads without a provider session can use the registered local project.
  // An isolated request without an authoritative session must never fall back to that project.
  if (thread.details?.mode === "worktree") throw new Error("workspace_preparing");
  return { path: project, ready: true };
}
