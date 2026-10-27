import { z } from "zod";
import {
  AccessRequest,
  AgentWorkspace,
  DelegationOutcome,
  DelegationRole,
  MachineName,
  MessageArrival,
  MessageText,
  MonitorSnapshot,
  ProviderKind,
  RunRole,
  ThreadId,
  WaitMode,
  WaitResult,
  WaitTimeoutSeconds,
  maxWaitThreads,
} from "@ace/protocol";
import {
  NoData,
  controlResult,
  controlTool,
  controlToolTimeoutMs,
  fields,
} from "./control-tool.ts";
import { maxBatchInputBytes } from "./result-budgets.ts";
import { withinCallBudget } from "./toolsets.ts";

/** The most children one `delegate` call starts; the guide quotes this number. */
export const maxDelegateTasks = maxWaitThreads;

const agents = { toolset: "ace-agents", timeoutMs: controlToolTimeoutMs } as const;
const childId = ThreadId.describe("From delegate or agents_status.");
const messagedThread = ThreadId.describe(
  "A child's or owned thread's id; with full access, any thread.",
);

const DelegateTask = z.strictObject({
  requestId: fields.requestId,
  task: MessageText.describe(
    "Goal, files, constraints, how to verify: the child sees none of your conversation.",
  ),
  role: DelegationRole.describe(
    "Unique name saying what and where: 'Fix-869-toast', never 'Implementer'.",
  ),
  runRole: RunRole.optional().describe("A role from your Roles line."),
  provider: ProviderKind.optional().describe("Default: yours, or the one serving model."),
  model: z.string().min(1).max(256).optional().describe('Id or name, e.g. "opus 5.5".'),
  accountId: z.string().min(1).max(256).optional().describe("Account id or label."),
  effort: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("e.g. low, high, xhigh. Default: yours on the same model."),
  access: AccessRequest.optional().describe("Default inherit; never above yours."),
  workspace: AgentWorkspace.optional(),
  machine: MachineName.optional().describe("From machines; needs project."),
  project: z.string().min(1).max(256).optional().describe("Its project in machines."),
});

const delegate = controlTool({
  ...agents,
  name: "delegate",
  title: "Delegate to child agents",
  riskClass: "agent-execution",
  capability: "agents",
  maxInputBytes: maxBatchInputBytes,
  description:
    "Start child agents as threads on any provider or paired machine, for independent or parallel work. Returns threadIds; set waitSeconds for results now, or end your turn and they arrive as a new one. Never poll. More: guide ace-agents.",
  input: z.strictObject({
    tasks: z.array(DelegateTask).min(1).max(maxDelegateTasks).describe("One per child."),
    waitSeconds: WaitTimeoutSeconds.optional().describe(
      "Wait for results, as wait does. Omit to return at once.",
    ),
    waitFor: WaitMode.default("all").describe("any returns on the first."),
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
      ...(waitSeconds === undefined
        ? {}
        : {
            await: waitFor,
            timeoutSeconds: withinCallBudget(waitSeconds, control.context.callBudgetSeconds),
          }),
    }),
});

const wait = controlTool({
  ...agents,
  name: "wait",
  title: "Wait for threads",
  riskClass: "read-only",
  capability: null,
  description:
    "Wait for children or other threads to settle. needs_you: one waits on the person; tell them, it is unfinished. timeout or interrupted: they keep working; wait again, never poll.",
  input: z.strictObject({
    threadIds: z
      .array(ThreadId)
      .min(1)
      .max(maxWaitThreads)
      .describe("From delegate, or any thread you can read."),
    mode: WaitMode.default("all").describe("any returns on the first."),
    timeoutSeconds: WaitTimeoutSeconds.default(120),
  }),
  output: controlResult(WaitResult),
  run: (input, control) =>
    control.run({
      op: "wait",
      ...input,
      timeoutSeconds: withinCallBudget(input.timeoutSeconds, control.context.callBudgetSeconds),
    }),
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
    "Your delegated children, here or on other machines. Without threadId: a snapshot of every child and descendant (state, step, elapsed, what waits on the person, queue, last output). With threadId: that child, with its result once settled. To block until they settle, use wait.",
  input: z.strictObject({
    threadId: childId.optional().describe("One child to read in full."),
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
    "Send follow-up work to a child (any machine), a thread you started or, with full access, any of the person's threads; it keeps its permissions. steer joins the running turn at the next tool boundary (Cursor restarts the turn), queue waits for it to end, restart interrupts its tree and replaces queued input. arrival says which applied.",
  input: z.strictObject({
    threadId: messagedThread,
    requestId: fields.requestId,
    text: MessageText.describe("Standing on its own."),
    delivery: z
      .enum(["queue", "steer", "restart"])
      .optional()
      .describe("Default: steer for your children, queue for other threads."),
  }),
  output: controlResult(z.looseObject({ arrival: MessageArrival })),
  run: (input, control) => control.run({ op: "thread.message", ...input }),
});

const agentCancel = controlTool({
  ...agents,
  name: "agent_cancel",
  title: "Cancel a child agent",
  riskClass: "thread-write",
  capability: "agents",
  description:
    "Stop a child and its descendants, on any machine. Acceptance is not proof it stopped: confirm with agents_status or wait.",
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
    "The person's other paired machines: name (pass as machine), online, access, projects, tool groups, providers, and transfers (true: transfer can move work there). Use with delegate {machine, project}; children there join wait and agents_status.",
  input: z.strictObject({}),
  output: controlResult(z.unknown()),
  run: (_, control) => control.run({ op: "machines" }),
});

const transfer = controlTool({
  ...agents,
  name: "transfer",
  title: "Move work to another machine",
  riskClass: "external-effect",
  capability: "agents",
  description:
    "Carry a project (default: this thread's) or this thread to another paired machine, same branch and uncommitted changes included. Returns transferId at once; the result arrives as a new turn, so end yours. Never poll.",
  input: z.strictObject({
    machine: MachineName.describe("From machines, with transfers true."),
    project: z.string().min(1).max(256).optional().describe("A project here, by id or name."),
    thread: z
      .literal("self")
      .optional()
      .describe("Continue this thread there as a new thread with its history."),
    includeChanges: z.boolean().optional().describe("Send uncommitted changes. Default true."),
    includeIgnored: z
      .boolean()
      .optional()
      .describe("Send ignored files like .env. Default: the setting."),
  }),
  output: controlResult(z.looseObject({ transferId: z.string() })),
  run: (input, control) => control.run({ op: "transfer", ...input }),
});

const models = controlTool({
  ...agents,
  name: "models",
  title: "List models for delegation",
  riskClass: "read-only",
  capability: null,
  description:
    "Models a child can run on, grouped by provider: each provider's accounts once (login state, availability, the access modes a child may take), its shared efforts and default, and its current models. A model names its accounts only when not every account serves it. Older releases are left out and counted in omitted; with query, the nearest models to a name across all providers and accounts, legacy included, nearest first. Pass a model's id to delegate.",
  input: z.strictObject({
    provider: ProviderKind.optional().describe("Only this provider's models."),
    query: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe('A model name as the person wrote it, such as "opus 5.5" or "gpt 6.1 sol".'),
  }),
  output: controlResult(z.unknown()),
  run: ({ provider, query }, control) =>
    control.run({
      op: "agents.models",
      ...(provider ? { provider } : {}),
      ...(query ? { query } : {}),
    }),
});

export const agentTools = [
  delegate,
  wait,
  agentsStatus,
  agentMessage,
  agentCancel,
  machines,
  transfer,
  models,
];
