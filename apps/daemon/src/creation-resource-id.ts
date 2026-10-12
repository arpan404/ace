import { createHash } from "node:crypto";
import { ThreadId, type Command } from "@ace/protocol";
import { requestedBaseKey } from "./worktree-base.ts";

/** The physical lease identity is shared by preparation and interrupted-draft recovery. */
export function creationResourceId(command: Command): ThreadId | undefined {
  const p = command.payload;
  if (p.type === "forge.pr.worktree")
    return ThreadId.parse(
      `pr-worktree:${createHash("sha256")
        .update(
          JSON.stringify([
            p.threadId,
            command.id,
            requestedBaseKey({ kind: "pull-request", selection: p.pullRequest }),
          ]),
        )
        .digest("hex")}`,
    );
  if ((p.type === "thread.create" || p.type === "thread.prepare") && p.threadId)
    return ThreadId.parse(p.threadId);
  return undefined;
}
