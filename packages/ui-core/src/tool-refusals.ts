import type { Item } from "@ace/protocol";
import { toolProblem } from "./ace-tool-problems.ts";
import { aceToolWords } from "./ace-tools.ts";
import { repeatCount } from "./repeated-events.ts";

/*
 * ace refusing or failing one of its own agent tools (a delegation over the parent's permission
 * ceiling, past the tree's budget, a thread read that failed): one compact failed row, not an
 * error block. The daemon reports each as an error notice whose title and text are the public
 * catalog's words for the agent ("Do not send the identical call again…"); the row says what
 * failed in a person's words instead, from the code and the tool. An agent that retries writes
 * the same notice again, and consecutive identical ones read as one row with a count. Pure.
 */

export interface ToolRefusal {
  /** What failed, in a few words: "Delegation refused", "Couldn't read a thread". */
  label: string;
  /** A short plain reason or what to do, when there is more to say than the label. */
  reason?: string | undefined;
  /** Refusals with the same key are the same refusal. */
  key: string;
}

type Notice = Extract<Item, { type: "notice" }>;

const labels: Record<string, string> = {
  delegation_denied: "Delegation refused",
  access_escalation_denied: "Delegation refused",
  delegation_limit: "Delegation limit reached",
  delegation_cancelled: "Delegation stopped",
};

function isRefusal(item: Item | undefined): item is Notice {
  if (item?.type !== "notice" || item.level !== "error") return false;
  if (item.raw.some((raw) => raw.type === "ace.agent_control.failed")) return true;
  return item.code !== undefined && item.code in labels;
}

/** The agent-control operation the daemon names in its report: `thread.read`, `delegate`. */
function operationOf(item: Notice): string | undefined {
  for (const raw of item.raw) {
    if (raw.type !== "ace.agent_control.failed" || !("data" in raw)) continue;
    const data: unknown = raw.data;
    const operation =
      typeof data === "object" && data !== null && "operation" in data ? data.operation : undefined;
    if (typeof operation === "string" && /^[a-z][a-z_.]{0,63}$/.test(operation)) return operation;
  }
  return undefined;
}

/**
 * What the tool tried, imperative ("read a thread"), from the tool the operation names. The
 * report carries no arguments, so the tool reads as acting on a thread, never "this thread".
 */
function attemptOf(operation: string | undefined): string {
  const tool = operation?.replaceAll(".", "_");
  const words = tool ? aceToolWords("ace", tool, { threadId: "a thread" }) : undefined;
  if (!words) return "finish that ace tool call";
  const said = words.target ? `${words.awaiting} ${words.target}` : words.awaiting;
  return said.charAt(0).toLowerCase() + said.slice(1);
}

/** `item` as a refused or failed agent tool, when it is one. Never the agent's own words. */
export function toolRefusal(item: Item | undefined): ToolRefusal | undefined {
  if (!isRefusal(item)) return undefined;
  const code = item.code ?? "execution_failed";
  const operation = operationOf(item);
  const problem = toolProblem({ family: "agents", code, attempt: attemptOf(operation) });
  const label = labels[code];
  return {
    label: label ?? problem.title,
    reason: label ? problem.title : problem.hint,
    key: `${item.agentId}\u0000${code}\u0000${operation ?? ""}`,
  };
}

/**
 * How many identical refusals the row at `index` stands for: 0 when an earlier row already
 * counts it, otherwise itself and the identical ones that follow with only tool calls,
 * reasoning or quiet notices between. Looks `span` items either way, never the whole thread.
 */
export function refusalCount(
  order: readonly string[],
  index: number,
  item: (id: string) => Item | undefined,
  span = 32,
): number {
  return repeatCount(order, index, item, (other) => toolRefusal(other)?.key, span);
}
