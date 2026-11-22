import { ThreadId } from "@ace/protocol";
import { bareToolName, type CallAdmission } from "@ace/mcp-server";
import { decide, host, tree, unplaced, type Operation, type Resource } from "./decide.ts";
import type { TreeResolver } from "./trees.ts";

/*
 * ace's own MCP tools under the access policy (ADR 0209 §4.1 "ace MCP", §6.1): an agent's call
 * runs as `agent` for the tree its lease was minted for. A tool listed nowhere here is refused
 * on an org host. Pure, apart from what the resolver reads.
 */

/** Tools that act only inside the caller's own tree, or on what it names inside it. */
const ownTree: readonly string[] = [
  "delegate",
  "wait",
  "agents_status",
  "agent_cancel",
  "agent_message",
  "queue_edit",
  "thread_control",
  "thread_link_pr",
  "thread_merge",
  "question_answer",
  "notify",
  "note_add",
  "note_retire",
  "image_show",
  "html_preview",
  "html_render",
  "command_run",
  "command_output",
  "command_status",
  "command_stop",
  "exec_command",
  "data_send",
  "data_receive",
  "review",
  "verify",
  "skill",
  "browser_act",
  "browser_logs",
  "browser_open",
  "browser_request_help",
  "browser_snapshot",
  "browser_tabs",
];

const table: Readonly<Record<string, Operation>> = {
  ...Object.fromEntries(ownTree.map((name) => [name, "tree.write" as const])),
  // The meta tools: what is offered, and calling it through the same admission.
  context: "session",
  guide: "session",
  tools_find: "session",
  tools_call: "session",
  thread_read: "tree.read",
  handoff_read: "tree.read",
  threads_find: "tree.read",
  automations_list: "tree.read",
  thread_start: "tree.create",
  thread_fork: "tree.create",
  automation_put: "tree.create",
  automation_remove: "tree.create",
  automation_run: "tree.create",
  models: "host.meta",
  projects_find: "host.meta",
  machines: "fleet.link",
  transfer: "transfer",
};

/** What a call is, or undefined when nobody classified the tool. */
export function mcpOperation(tool: string): Operation | undefined {
  const name = bareToolName(tool);
  if (name.startsWith("screen_") || name.startsWith("sim_")) return "computer";
  return table[name];
}

const threadIn = (input: unknown): ThreadId | undefined => {
  for (const key of ["threadId", "thread"]) {
    const parsed = ThreadId.safeParse(Reflect.get(Object(input), key));
    if (parsed.success) return parsed.data;
  }
  return undefined;
};

/** Tools that list or search across trees: nothing places them until the access table can filter. */
const lists: ReadonlySet<string> = new Set(["threads_find", "automations_list"]);

/**
 * The tree a call acts on: the thread its arguments name, else the caller's own tree, bound
 * when its lease was minted. A list or search names no tree and can't be placed.
 */
export function mcpResource(
  tool: string,
  operation: Operation,
  input: unknown,
  own: ThreadId,
): Resource {
  if (!operation.startsWith("tree.")) return host;
  if (lists.has(bareToolName(tool))) return unplaced;
  const named = threadIn(input);
  return named === undefined ? tree({ root: own }) : tree({ thread: named });
}

/** Spade's own lease (ADR 0123): shared bots keep ADR 0206 §2.3's rules, not a tree's. */
const spadeSession = (sessionId: string) => sessionId.startsWith("spade:");

/**
 * The admission ace's MCP registry runs before each call. On a person's machine it admits
 * everything, as before.
 */
export function mcpAdmission(deps: {
  org: () => string | undefined;
  trees: TreeResolver;
}): CallAdmission {
  return (tool, input, caller) => {
    if (deps.org() === undefined || spadeSession(caller.sessionId)) return true;
    // The tree its lease was minted for, fixed then: never what the call's arguments say.
    const root = deps.trees.root({ thread: caller.threadId });
    if (root === undefined) return false;
    const operation = mcpOperation(tool);
    if (operation === undefined) return false;
    const resource = mcpResource(tool, operation, input, root);
    return decide({ kind: "agent", root }, operation, resource, deps.trees).allowed;
  };
}
