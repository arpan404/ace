/*
 * The transcript's one grouping rule. Consecutive items of the same kind by the same agent within
 * one run merge into one row: subagents, tool calls (by family, `stepFamily`), background tasks,
 * file edits. Anything the agent says, a person's message, a question or an error ends a group,
 * whatever follows it. A group of one is a plain row. The work log applies it step by step
 * (`groupSteps`); the transcript's blocks apply it to background tasks and launches. Pure.
 */

/** What can merge with its neighbour. */
export type MergingKind = "subagents" | "tool" | "background" | "edit";

/** What always stands alone and ends the group before it. */
export type BreakingKind = "prose" | "user" | "question" | "error";

export interface GroupEntry {
  kind: MergingKind | BreakingKind;
  agentId: string;
  /** The run it happened in; items of two runs never merge. */
  runId?: string | undefined;
  /** A tool call's family (`stepFamily`): calls of two families never merge. */
  family?: string | undefined;
}

const breaking = new Set<GroupEntry["kind"]>(["prose", "user", "question", "error"]);

/** Whether `next` joins the group whose newest entry is `previous`. */
export function mergesWith(previous: GroupEntry | undefined, next: GroupEntry): boolean {
  if (!previous) return false;
  if (breaking.has(previous.kind) || breaking.has(next.kind)) return false;
  return (
    previous.kind === next.kind &&
    previous.agentId === next.agentId &&
    previous.runId === next.runId &&
    previous.family === next.family
  );
}
