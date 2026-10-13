import type { AgentControlOperation, AgentControlResult } from "@ace/protocol";

type Op = AgentControlOperation["op"];
type Code = NonNullable<AgentControlResult["code"]>;

/** Fixed next steps for agent-control failures. Authored here; never derived from backend text. */
const byCode: Record<Code, string> = {
  forbidden:
    "This thread cannot do that to that thread: it is outside your project, or you may read it but only its owner may change it. Use ace_threads_list for ids you can reach.",
  not_found: "No such id. Use an id from an earlier result or from ace_threads_list.",
  not_ready:
    "The target is still working or waiting on a person. Call ace_wait with its threadId, or ace_agent_status to see what it waits on.",
  limit: "The result exceeded its budget. Ask for less: a smaller limit, a query or a cursor.",
  unsupported: "This ace daemon does not offer this operation. Do not retry it.",
  invalid: "The arguments parsed but do not fit the target's current state. Check ids and values.",
  unavailable:
    "The target cannot accept this now: its session is closed or it is not running. Check ace_agent_status before retrying.",
};
const byOp: Partial<Record<Op, Partial<Record<Code, string>>>> = {
  "thread.rename": {
    not_ready: "The title is no longer provisional. Keep it; do not rename again.",
  },
  "thread.regenerate_title": { not_ready: "There is no user message to title from yet." },
  "thread.settle": { not_ready: "Archive a thread only after it is done or failed." },
  "question.answer": { not_ready: "That question is no longer pending." },
};

export function withControlHint(op: Op, result: AgentControlResult): AgentControlResult {
  if (result.ok || result.hint || !result.code) return result;
  return { ...result, hint: byOp[op]?.[result.code] ?? byCode[result.code] };
}
