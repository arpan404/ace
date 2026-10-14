import { z } from "zod";
import {
  AccessMode,
  AgentControlResult,
  DelegationOutcome,
  MonitorSnapshot,
  WaitResult,
  type AgentControlOperation,
} from "@ace/protocol";

/**
 * Per-operation result types for the agent-control tools. They name the fields an agent reads and
 * stay open (`looseObject`) so a richer owner result still validates; they never narrow data.
 * Operations whose result belongs to another owner (forge, automations, previews, remote devices,
 * worktrees) keep an open `data` until those owners publish a schema.
 */
const id = z.string().min(1);
const Status = z.looseObject({ state: z.string() });
const ThreadSummary = z.looseObject({
  id,
  title: z.string(),
  titleSource: z.string().optional(),
  provider: z.string(),
  workspaceId: id,
  status: Status,
  permission: z.looseObject({ effective: z.string().nullable() }).optional(),
});
const Item = z.looseObject({ type: z.string(), id: id.optional() });
const Hit = z.looseObject({
  threadId: id,
  threadTitle: z.string().optional(),
  itemId: id.optional(),
  status: z.string().optional(),
  provider: z.string().optional(),
  snippet: z.looseObject({ text: z.string() }).optional(),
});
const SearchPage = z.looseObject({
  hits: z.array(Hit),
  cursor: z.string().nullable().optional(),
});
const TaskView = z.looseObject({
  threadId: id,
  state: z.enum([
    "working",
    "waiting_on_human",
    "waiting_on_children",
    "result_available",
    "failed",
    "cancelled",
  ]),
  outcome: DelegationOutcome.optional(),
});
const Catalog = z.looseObject({
  models: z.array(
    z.looseObject({ id, displayName: z.string().optional(), provider: z.string().optional() }),
  ),
  instances: z.array(
    z.looseObject({
      provider: z.string(),
      installed: z.boolean(),
      auth: z.string(),
      allowedAccessModes: z.array(AccessMode),
    }),
  ),
  caller: z.looseObject({ threadId: id, access: AccessMode.nullable() }),
});

type Op = AgentControlOperation["op"];
const data: Partial<Record<Op, z.ZodType>> = {
  "threads.list": SearchPage,
  "thread.search": SearchPage,
  "agents.catalog": Catalog,
  "agent.status": TaskView,
  "agent.result": TaskView,
  // One task returns threadId (and outcome when it waited); a batch returns threadIds, and wait
  // when it awaited.
  delegate_task: z.looseObject({
    threadId: id.optional(),
    outcome: DelegationOutcome.optional(),
    threadIds: z.array(id).optional(),
    wait: WaitResult.optional(),
  }),
  wait: WaitResult,
  "agents.status": MonitorSnapshot,
  "thread.read": z.looseObject({
    thread: ThreadSummary.optional(),
    items: z.array(Item).optional(),
    itemsBefore: z.number().nullable().optional(),
    linkedPrs: z.array(z.unknown()).optional(),
  }),
  "thread.read_output": z.looseObject({
    bytes: z.string().describe("Base64"),
    nextOffset: z.number().optional(),
  }),
  "project.read": z.looseObject({ id, name: z.string() }),
  "project.rename": z.looseObject({ id, name: z.string() }),
};
/** Operations that never return data: success or failure is the whole answer. */
const noData = new Set<Op>([
  "agent.cancel",
  "agent.message",
  "thread.message",
  "thread.interrupt",
  "question.answer",
  "thread.rename",
  "thread.regenerate_title",
  "thread.settle",
  "thread.snooze",
]);

const { data: _open, ...base } = AgentControlResult.shape;
export function controlOutput(op: Op) {
  if (noData.has(op)) return z.object(base);
  const typed = data[op];
  return z.object({ ...base, data: (typed ?? z.unknown()).optional() });
}
