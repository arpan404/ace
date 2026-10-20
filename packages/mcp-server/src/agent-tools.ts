import { z } from "zod";
import {
  AccessRequest,
  AgentWorkspace,
  DelegationOutcome,
  DelegationRole,
  MachineName,
  MessageText,
  MonitorSnapshot,
  ProviderKind,
  ThreadId,
  WaitMode,
  WaitResult,
  WaitTimeoutSeconds,
  maxWaitThreads,
} from "@ace/protocol";
import { OffshiftRole } from "@ace/protocol/offshift";
import {
  NoData,
  controlResult,
  controlTool,
  controlToolTimeoutMs,
  fields,
} from "./control-tool.ts";
import { maxBatchInputBytes } from "./result-budgets.ts";

/** The most children one `delegate` call starts; the guide quotes this number. */
export const maxDelegateTasks = maxWaitThreads;

const agents = { toolset: "ace-agents", timeoutMs: controlToolTimeoutMs } as const;
const childId = ThreadId.describe("A child's threadId, from delegate or agents_status.");
const messagedThread = ThreadId.describe(
  "A child's or owned thread's id; with full access, any of the person's threads.",
);

const DelegateTask = z.strictObject({
  requestId: fields.requestId,
  task: MessageText.describe(
    "The whole assignment: goal, files, constraints, project notes that apply, and how to verify. The child sees none of your conversation.",
  ),
  role: DelegationRole,
  runRole: OffshiftRole.optional().describe("Fill unset fields from your Offshift role."),
  provider: ProviderKind.optional().describe(
    "Provider that runs the child. Default: yours, or the one whose catalog has `model`.",
  ),
  model: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "A model id from `models`. Default: the provider's default model. ace picks the account and instance that serve it.",
    ),
  effort: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Reasoning effort, such as low, medium, high or xhigh. Default inherit: yours on the same model, else the model's default.",
    ),
  access: AccessRequest.optional().describe(
    "The child's access mode. Default inherit (yours); never broader than yours.",
  ),
  workspace: AgentWorkspace.optional().describe(
    "Where the child works. Default: this project's checkout. new_worktree starts a Git worktree from base; existing_worktree reuses one by path.",
  ),
  machine: MachineName.optional().describe(
    "Run on this paired machine (a name from `machines`). Requires project.",
  ),
  project: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("The project on that machine, as `machines` lists it."),
});

const delegate = controlTool({
  ...agents,
  name: "delegate",
  title: "Delegate to child agents",
  riskClass: "agent-execution",
  capability: "agents",
  maxInputBytes: maxBatchInputBytes,
  description: `Start child agents as their own threads, on any installed provider or a paired machine, for independent or parallel work (prefer this to your provider's built-in subagent tool). One call takes 1 to ${maxDelegateTasks} tasks and returns their threadIds at once. To use results this turn, set waitSeconds; otherwise end your turn and settled results arrive as a new turn. Never poll. Fields and examples: guide ace-agents.`,
  input: z.strictObject({
    tasks: z
      .array(DelegateTask)
      .min(1)
      .max(maxDelegateTasks)
      .describe("One entry per child. Roles must be unique among your live children."),
    waitSeconds: WaitTimeoutSeconds.optional().describe(
      "Wait up to this many seconds for the children before returning, as `wait` does. Omit to return at once.",
    ),
    waitFor: WaitMode.default("all").describe(
      "With waitSeconds: return when all children settle (default) or when any does.",
    ),
  }),
  output: controlResult(
    z.looseObject({
      threadIds: z.array(z.string()),
      wait: WaitResult.optional(),
    }),
  ),
  run: ({ tasks, waitSeconds, waitFor }, control) =>
    control.run({
      op: "delegate_task",
      tasks,
      ...(waitSeconds === undefined ? {} : { await: waitFor, timeoutSeconds: waitSeconds }),
    }),
});

const wait = controlTool({
  ...agents,
  name: "wait",
  title: "Wait for threads",
  riskClass: "read-only",
  capability: null,
  description:
    "Block until threads settle, up to timeoutSeconds. Returns early with needs_you, naming each request, when a thread waits on the person: tell the person and treat it as unfinished. timeout or interrupted: the threads keep working; call wait again, never a polling loop.",
  input: z.strictObject({
    threadIds: z
      .array(ThreadId)
      .min(1)
      .max(maxWaitThreads)
      .describe("Threads to watch: children from delegate, or any thread you can read."),
    mode: WaitMode.default("all").describe("all (default): every thread settles; any: the first."),
    timeoutSeconds: WaitTimeoutSeconds.default(120).describe("Longest wait in seconds."),
  }),
  output: controlResult(WaitResult),
  run: (input, control) => control.run({ op: "wait", ...input }),
});

const ChildView = z.looseObject({
  threadId: z.string(),
  state: z.string(),
  outcome: DelegationOutcome.optional(),
});
const agentsStatus = controlTool({
  ...agents,
  name: "agents_status",
  title: "Check child agents",
  riskClass: "read-only",
  capability: null,
  description:
    "Your delegated children, on this machine or others. Without threadId: a compact snapshot of every child and its descendants (state, current step, elapsed seconds, what waits on the person, last output line). With threadId: that child's state and, once it has settled, its result. To block until children settle, call wait instead.",
  input: z.strictObject({
    threadId: childId
      .optional()
      .describe("One child to read in full, with its result once settled."),
  }),
  output: controlResult(z.union([MonitorSnapshot, ChildView])),
  run: ({ threadId }, control) =>
    control.run(threadId ? { op: "agent.status", threadId } : { op: "agents.status" }),
});

const agentMessage = controlTool({
  ...agents,
  name: "agent_message",
  title: "Message a child or another thread",
  riskClass: "agent-execution",
  capability: "agents",
  description:
    "Send follow-up work to a child or a thread you started, or with full access to any of the person's threads; it keeps its permissions. delivery queue (default) waits for its current turn to end, steer injects now, restart interrupts its tree and replaces queued input with this text.",
  input: z.strictObject({
    threadId: messagedThread,
    requestId: fields.requestId,
    text: MessageText.describe("The message, standing on its own."),
    delivery: z
      .enum(["queue", "steer", "restart"])
      .default("queue")
      .describe("queue (default), steer, or restart."),
  }),
  output: NoData,
  run: (input, control) => control.run({ op: "thread.message", ...input }),
});

const agentCancel = controlTool({
  ...agents,
  name: "agent_cancel",
  title: "Cancel a child agent",
  riskClass: "thread-write",
  capability: "agents",
  description:
    "Stop a child and all its descendants, here or on another machine. Acceptance is not proof the tree stopped: confirm with agents_status or wait.",
  input: z.strictObject({ threadId: childId, requestId: fields.requestId }),
  output: NoData,
  run: (input, control) => control.run({ op: "agent.cancel", ...input }),
});

const machines = controlTool({
  ...agents,
  name: "machines",
  title: "List paired machines",
  riskClass: "read-only",
  capability: null,
  description:
    "Other machines the person paired that let agents in: name (pass as machine), online or offline, access (read or operate), projects, tool groups and providers. Use with delegate {machine, project}; delegated children there join wait and agents_status.",
  input: z.strictObject({}),
  output: controlResult(z.unknown()),
  run: (_, control) => control.run({ op: "machines" }),
});

const CatalogPage = z.looseObject({
  models: z.array(z.looseObject({ id: z.string() })),
  instances: z.array(z.looseObject({ provider: z.string() })),
});
const models = controlTool({
  ...agents,
  name: "models",
  title: "List models for delegation",
  riskClass: "read-only",
  capability: null,
  description:
    "Models a child can run on, with their efforts, and the installed providers with their login state and the access modes a child may take. Pass a model's id to delegate. Page with offset.",
  input: z.strictObject({
    provider: ProviderKind.optional().describe("Only this provider's models."),
    offset: z.number().int().min(0).max(40_960).default(0).describe("From nextOffset."),
  }),
  output: controlResult(z.unknown()),
  async run({ provider, offset }, control) {
    const result = await control.run({
      op: "agents.catalog",
      ...(provider ? { provider } : {}),
      offset,
      limit: 20,
    });
    const page = CatalogPage.safeParse(result.data);
    return page.success ? { ...result, data: compactCatalog(page.data) } : result;
  },
});

const pick = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])));
/** The catalog fields a model chooses by; native selectors and refresh state stay in ace. */
function compactCatalog(page: z.infer<typeof CatalogPage>) {
  return {
    models: page.models.map((model) => ({
      ...pick(model, ["id", "displayName", "provider", "defaultEffort", "isDefault"]),
      ...(Array.isArray(model["efforts"])
        ? {
            efforts: model["efforts"].flatMap((effort: unknown) =>
              typeof effort === "object" && effort !== null && "id" in effort ? [effort.id] : [],
            ),
          }
        : {}),
    })),
    providers: page.instances.map((instance) =>
      pick(instance, ["provider", "accountLabel", "installed", "auth", "allowedAccessModes"]),
    ),
    ...pick(page, ["nextOffset", "caller"]),
  };
}

export const agentTools = [
  delegate,
  wait,
  agentsStatus,
  agentMessage,
  agentCancel,
  machines,
  models,
];
