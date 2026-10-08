import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { CommandRefused } from "./daemon-command.ts";

/** One owner for the working-tree diff read used by Changes and fork merges. */
export async function readGitDiff(client: ClientApi, threadId: string, signal?: AbortSignal) {
  const reply = await client.request(
    {
      type: "workspace.request",
      operation: { op: "git.diff", threadId: ThreadId.parse(threadId) },
    },
    signal ? { signal } : {},
  );
  if (reply.result.kind !== "gitDiff") throw new CommandRefused("merge_patch_unavailable");
  return reply.result;
}

export async function readMergePatch(client: ClientApi, threadId: string): Promise<string> {
  const diff = await readGitDiff(client, threadId);
  if (diff.truncated || new TextEncoder().encode(diff.patch).byteLength > 65536)
    throw new CommandRefused("merge_patch_too_large");
  if (!diff.patch) throw new CommandRefused("merge_patch_empty");
  return diff.patch;
}
