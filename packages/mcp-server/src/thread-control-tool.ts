import { z } from "zod";
import { AgentControlOperation, ThreadId, Timestamp } from "@ace/protocol";
import { controlResult, controlTool, controlToolTimeoutMs, fields } from "./control-tool.ts";

type Operation = z.input<typeof AgentControlOperation>;

/** Each action's required fields, named in its description and checked before anything runs. */
const needs = {
  rename: [],
  configure: ["requestId", "model"],
  fork: ["requestId"],
  handoff: ["requestId", "branch"],
  interrupt: ["requestId"],
  settle: [],
  unsettle: [],
  snooze: ["until"],
  close_preview: ["previewId"],
  rename_project: ["name"],
} as const;
type Action = keyof typeof needs;
const actions = Object.keys(needs) as [Action, ...Action[]];

const Input = z
  .strictObject({
    action: z
      .enum(actions)
      .describe(
        "rename: set title, or omit title to retitle from the first message. configure: model and effort. fork: copy the conversation into a new thread. handoff: move it to a new Git worktree on branch. interrupt: stop its current turn and its children. settle: move it to Settled, as the person's Settle does; a thread still working (this one, mid-turn) settles when it is done, unless it fails or needs the person. unsettle: bring it back and cancel a pending settle. snooze: mute its notifications until a time. close_preview: stop a preview server. rename_project: rename this project.",
      ),
    threadId: ThreadId.optional().describe("A thread you own. Default: this thread."),
    requestId: fields.requestId.optional(),
    title: z.string().min(1).max(256).optional().describe("rename: the new title."),
    onlyIfProvisional: z
      .boolean()
      .optional()
      .describe("rename: only replace a title ace generated, never one the person chose."),
    model: z.string().min(1).max(256).optional().describe("configure: a model id from `models`."),
    effort: z.string().min(1).max(64).optional().describe("configure: reasoning effort."),
    serviceTier: z.enum(["default", "priority", "flex"]).optional().describe("configure."),
    runId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("fork: fork after this run; default the latest."),
    branch: z.string().min(1).max(256).optional().describe("handoff: the new branch name."),
    until: Timestamp.nullable()
      .optional()
      .describe("snooze: epoch milliseconds, or null to unmute."),
    previewId: z.string().min(1).max(128).optional().describe("close_preview: from thread_read."),
    name: z.string().min(1).max(256).optional().describe("rename_project: the new name."),
  })
  .superRefine((input, context) => {
    for (const field of needs[input.action])
      if (input[field] === undefined)
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${input.action} needs ${field}.`,
        });
  })
  .meta({
    "x-ace-constraint":
      "configure needs requestId and model; fork and interrupt need requestId; handoff needs requestId and branch; snooze needs until; close_preview needs previewId; rename_project needs name.",
  });
type Input = z.output<typeof Input>;

/** The one operation an action stands for. Required fields were checked by the schema. */
function operation(input: Input, threadId: string): Operation {
  const requestId = input.requestId ?? "";
  switch (input.action) {
    case "rename":
      return input.title
        ? {
            op: "thread.rename",
            threadId,
            title: input.title,
            ...(input.onlyIfProvisional === undefined
              ? {}
              : { onlyIfProvisional: input.onlyIfProvisional }),
          }
        : { op: "thread.regenerate_title", threadId };
    case "configure":
      return {
        op: "thread.configure",
        threadId,
        requestId,
        model: input.model ?? "",
        options: {
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
        },
      };
    case "fork":
      return {
        op: "thread.fork",
        threadId,
        requestId,
        ...(input.runId ? { runId: input.runId } : {}),
      };
    case "handoff":
      return { op: "thread.handoff", threadId, requestId, branch: input.branch ?? "" };
    case "interrupt":
      return { op: "thread.interrupt", threadId, requestId };
    case "settle":
      return { op: "thread.settle", threadId };
    case "unsettle":
      return { op: "thread.unsettle", threadId };
    case "snooze":
      return { op: "thread.snooze", threadId, until: input.until ?? null };
    case "close_preview":
      return { op: "preview.close", threadId, previewId: input.previewId ?? "" };
    case "rename_project":
      return { op: "project.rename", name: input.name ?? "" };
  }
}

/**
 * Every non-destructive change to an owned thread, as one tool with an action. Merging a
 * thread's work overwrites files, so it stays its own tool (`thread_merge`): MCP annotations
 * are per tool, and a destructive hint here would make every rename ask the person.
 */
export const threadControl = controlTool({
  toolset: "ace-threads",
  timeoutMs: controlToolTimeoutMs,
  name: "thread_control",
  title: "Change an owned thread",
  riskClass: "thread-write",
  capability: "thread_control",
  description:
    "Change a thread you own (this one or one you started): rename, configure its model, fork, hand off to a new worktree, interrupt, settle (this thread too, when its work is finished) or unsettle, snooze, close a preview server, or rename this project. Each action's fields are named in action's description.",
  input: Input,
  output: controlResult(z.unknown()),
  async run(input, control) {
    if (input.action === "rename_project" && !control.context.capabilities.includes("projects"))
      return { ok: false, code: "forbidden", hint: "Project changes are off for this thread." };
    return control.run(operation(input, input.threadId ?? control.context.caller.threadId));
  },
});
