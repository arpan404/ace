import { z } from "zod";
import { AgentControlOperation, ThreadId, Timestamp } from "@ace/protocol";
import { controlResult, controlTool, controlToolTimeoutMs, fields } from "./control-tool.ts";

type Operation = z.input<typeof AgentControlOperation>;

/** Each action's required fields, named in its description and checked before anything runs. */
const needs = {
  rename: [],
  configure: ["requestId", "model"],
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
        "rename: title, or none to retitle from the first message. configure: model, effort. handoff: branch. interrupt: stops its turn and children. settle: a working thread settles once done, unless it fails or needs the person. unsettle: also cancels a pending settle. snooze: until. close_preview: previewId. rename_project: name.",
      ),
    threadId: ThreadId.optional().describe("Default: this thread."),
    requestId: fields.requestId.optional(),
    title: z.string().min(1).max(256).optional(),
    onlyIfProvisional: z
      .boolean()
      .optional()
      .describe("Only replace a title ace generated, never the person's."),
    model: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe('Id from models, or a name ("opus 5.5") on its account.'),
    effort: z.string().min(1).max(64).optional(),
    serviceTier: z.enum(["default", "priority", "flex"]).optional(),
    branch: z.string().min(1).max(256).optional(),
    until: Timestamp.nullable().optional().describe("Epoch ms, or null to unmute."),
    previewId: z.string().min(1).max(128).optional().describe("From thread_read."),
    name: z.string().min(1).max(256).optional(),
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
      "configure needs requestId and model; interrupt needs requestId; handoff needs requestId and branch; snooze needs until; close_preview needs previewId; rename_project needs name.",
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
    "Change a thread you own (this one, ones you started or, with full access, any): rename, configure its model, hand off to a new worktree, interrupt, settle, unsettle, snooze, close a preview server, or rename this project. Settle this thread too when its work is done.",
  input: Input,
  output: controlResult(z.unknown()),
  async run(input, control) {
    if (input.action === "rename_project" && !control.context.capabilities.includes("projects"))
      return { ok: false, code: "forbidden", hint: "Project changes are off for this thread." };
    return control.run(operation(input, input.threadId ?? control.context.caller.threadId));
  },
});
