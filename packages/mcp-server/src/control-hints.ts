import type { AgentControlOperation, AgentControlResult } from "@ace/protocol";

type Op = AgentControlOperation["op"];
type Code = NonNullable<AgentControlResult["code"]>;

/**
 * Fixed next steps for agent-control failures, each naming the agent's own next call. Authored
 * here; never derived from backend text.
 */
const byCode: Record<Code, string> = {
  forbidden:
    "That thread is outside your project, or only its owner may change it. Call threads_find for threads you can read; change only this thread or ones you started.",
  not_found: "No such id. Use an id from an earlier result, threads_find or agents_status.",
  not_ready:
    "The target is still working or waiting on a person. Call wait with its threadId, or agents_status to see what it waits on.",
  limit:
    "The result exceeded its budget. Call again with a smaller limit, a narrower query or the cursor.",
  unsupported:
    "This ace daemon does not offer this operation. Do not retry it; do the work another way.",
  invalid:
    "The arguments parsed but do not fit the target's current state. Re-read it with thread_read, then fix the ids or values.",
  unavailable:
    "The target cannot accept this now: its session is closed or it is not running. Call agents_status, then retry or start new work with delegate.",
};
const byOp: Partial<Record<Op, Partial<Record<Code, string>>>> = {
  "thread.rename": {
    not_ready: "The title is no longer provisional. Keep it; do not rename again.",
  },
  "thread.regenerate_title": { not_ready: "There is no user message to title from yet." },
  "thread.settle": {
    not_ready: "It cannot be settled in its current state. Call thread_read for its status.",
  },
  "question.answer": {
    not_ready: "That question is no longer pending. Call agents_status for current requests.",
  },
  "thread.configure": {
    invalid: "That model is not available to this thread. Call models and pick a listed id.",
  },
};

export function withControlHint(op: Op, result: AgentControlResult): AgentControlResult {
  if (result.ok || result.hint || !result.code) return result;
  return { ...result, hint: byOp[op]?.[result.code] ?? byCode[result.code] };
}
