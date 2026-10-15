import { controlActions } from "./control-actions.ts";
import { z } from "zod";
import {
  AgentControlOperation,
  ThreadId,
  type AgentControlResult,
  type McpAttribution,
} from "@ace/protocol";
import { controlOutput } from "./control-outputs.ts";
import { withControlHint } from "./control-hints.ts";
import type { Toolkit } from "./toolkits.ts";

/** The longest bounded wait plus transport grace, still inside every provider's tool timeout. */
const waitToolTimeoutMs = 630_000;

export interface AgentControlPort {
  execute(
    caller: McpAttribution,
    operation: AgentControlOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult>;
}
/** A tool's input never carries `op`; its documented examples drop it too. */
function toolMeta(meta: Record<string, unknown> | undefined) {
  const examples = meta?.["examples"];
  if (!Array.isArray(examples)) return { ...meta };
  return {
    ...meta,
    examples: examples.map((example: unknown) =>
      typeof example === "object" && example !== null
        ? Object.fromEntries(Object.entries(example).filter(([key]) => key !== "op"))
        : example,
    ),
  };
}
/** Each operation has its own schema. No arbitrary command or permission-answer entry exists. */
/** Host-internal steps of delegation; agents start child work only through delegate_task. */
const internalOps = new Set(["thread.create", "thread.launch"]);
export const agentControlToolCatalog = AgentControlOperation.options.flatMap((schema) => {
  const { op: opSchema, ...shape } = schema.shape;
  const op = opSchema.value;
  if (internalOps.has(op)) return [];
  return {
    op,
    riskClass: controlActions[op].riskClass,
    destructive: controlActions[op].destructive === true,
    name: op === "delegate_task" ? "delegate_task" : `ace_${op.replaceAll(".", "_")}`,
    description:
      op === "delegate_task"
        ? "Start child threads on any provider: one task, or several with tasks: [...]. Returns their ids at once. To use results this turn, set await (any or all) with timeoutSeconds, or call ace_wait with the ids; never poll. If you end your turn instead, settled results arrive as a new turn. Stable requestIds make retries create nothing new. Fields, machines and access: ace_guide ace-agents."
        : op === "thread.read_output"
          ? "Read a bounded byte range from a transcript/output source returned by ace_thread_read. Offsets and limits are bytes; the result contains base64 bytes and nextOffset. Decode using the source encoding. The stream must belong to the requested authorized thread."
          : op === "thread.read"
            ? "Read a thread's metadata (title, titleSource, status, permission, branch) and a byte-budgeted transcript page. Omit threadId for your own thread. Use itemsBefore as the next before cursor. For truncated parts with source.streamId, use ace_thread_read_output to page retained bytes."
            : controlActions[op].description,
    input:
      op === "thread.link_pr" || op === "thread.unlink_pr" || op === "delegate_task"
        ? z
            .strictObject(shape)
            .superRefine((input, context) => {
              const parsed = schema.safeParse({ ...input, op });
              if (!parsed.success)
                for (const issue of parsed.error.issues)
                  context.addIssue({ code: "custom", message: issue.message, path: issue.path });
            })
            .meta(toolMeta(schema.meta()))
        : op === "thread.read"
          ? z.strictObject({ ...shape, threadId: ThreadId.optional() })
          : z.strictObject(shape),
    output: controlOutput(op),
    capability:
      controlActions[op].riskClass === "read-only"
        ? null
        : op === "automation.manage"
          ? ("automations" as const)
          : op.startsWith("project.")
            ? ("projects" as const)
            : op === "delegate_task" || op === "device.delegate" || op.startsWith("agent.")
              ? ("agents" as const)
              : ("thread_control" as const),
    timeoutMs:
      op === "wait" || op === "delegate_task"
        ? waitToolTimeoutMs
        : op === "thread.start" || op === "device.task_wait" || op === "device.task_publish"
          ? 300000
          : 10000,
  };
});
/** ace's own tools a provider should still gate itself: the rest never prompt there. */
export const destructiveAceTools: readonly string[] = agentControlToolCatalog
  .filter((definition) => definition.destructive)
  .map((definition) => definition.name);
export function agentControlToolkit(port: AgentControlPort): Toolkit {
  return {
    register(registry) {
      for (const definition of agentControlToolCatalog)
        registry.register({
          ...definition,
          async run(input: z.output<typeof definition.input>, context) {
            // ace_thread_read without a threadId reads the caller's own thread.
            const own =
              definition.op === "thread.read" && !("threadId" in input && input.threadId)
                ? { threadId: context.caller.threadId }
                : {};
            const operation = AgentControlOperation.parse({ ...input, ...own, op: definition.op });
            return withControlHint(
              definition.op,
              await port.execute(context.caller, operation, context.signal),
            );
          },
        });
    },
  };
}
