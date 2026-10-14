import type { Fact } from "@ace/core";
import type { Scenario } from "../scenario.ts";
import { aceCall } from "./ace-tools.ts";
import { endTurn, message, rootAgent, turn } from "./facts.ts";

const reason = 'The parent thread runs opencode in "plan". Allowed claude modes: "plan".';

/** The daemon's report of one refused agent tool call (services/agent-control-failure.ts). */
function refusal(item: string): Fact {
  return {
    type: "item.upsert",
    agent: "root",
    item,
    draft: {
      type: "notice",
      level: "error",
      complete: true,
      code: "delegation_denied",
      title: "Child permissions exceed the parent permission ceiling",
      text: reason,
      raw: [{ type: "ace.agent_control.failed", data: { operation: "delegate_task" } }],
    },
  };
}

/**
 * The owner's 2026-10-13 OpenCode thread: three delegations to Claude refused by the parent's
 * permission ceiling, then the agent's own explanation.
 */
export function refusedDelegation(id = "thread-refused-delegation"): Scenario {
  const failed = JSON.stringify({
    code: "delegation_denied",
    message: "Child permissions exceed the parent permission ceiling",
    hint: "Choose a permission mode allowed by the parent thread.",
    detail: reason,
  });
  const facts: Fact[] = [rootAgent("opencode"), turn("root")];
  facts.push(
    message(
      "root",
      "ask",
      "user",
      "can you delegate the task to a subagent using ace to claude haiku 5.5",
    ),
  );
  for (const [index, access] of ["full-access", undefined, "ask"].entries()) {
    const item = `delegate-${index}`;
    facts.push(
      aceCall(
        "root",
        item,
        "delegate_task",
        {
          provider: "claude",
          model: "claude-haiku-5-5",
          role: "helper",
          task: "Take over the task",
          ...(access ? { access } : {}),
        },
        [{ type: "text", text: failed }],
        true,
      ),
      refusal(`refusal-${index}`),
    );
  }
  facts.push(
    message(
      "root",
      "answer",
      "assistant",
      'Claude can only run in "plan" under this thread\'s Plan mode. Want me to retry with `plan`?',
    ),
    endTurn("root"),
  );
  return {
    thread: { id, workspaceId: "ace", title: "Delegate to Claude Haiku", provider: "opencode" },
    steps: [{ kind: "facts", facts }],
  };
}
