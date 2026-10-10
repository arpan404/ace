import { controlActions } from "./control-actions.ts";
import { z } from "zod";
import { AgentControlOperation, AgentControlResult, type McpAttribution } from "@ace/protocol";
import type { Toolkit } from "./toolkits.ts";

export interface AgentControlPort {
  execute(
    caller: McpAttribution,
    operation: AgentControlOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult>;
}
/** Each operation has its own schema. No arbitrary command or permission-answer entry exists. */
export const agentControlToolCatalog = AgentControlOperation.options.map((schema) => {
  const { op: opSchema, ...shape } = schema.shape;
  const op = opSchema.value;
  return {
    op,
    riskClass: controlActions[op].riskClass,
    name: op === "delegate_task" ? "delegate_task" : `ace_${op.replaceAll(".", "_")}`,
    description:
      op === "delegate_task"
        ? "Delegate to an independent child thread under the parent permission ceiling and delegation budget, on a chosen local provider, model and account. Set wait to receive its outcome in this tool result; otherwise completion results wake the parent as ace context in a batched turn. Request IDs make retries safe."
        : op === "thread.read_output"
          ? "Read a bounded byte range from a transcript/output source returned by ace_thread_read. Offsets and limits are bytes; the result contains base64 bytes and nextOffset. Decode using the source encoding. The stream must belong to the requested authorized thread."
          : op === "thread.read"
            ? "Read thread metadata and a byte-budgeted transcript page. Use itemsBefore as the next before cursor. For truncated parts with source.streamId, use ace_thread_read_output to page retained bytes."
            : controlActions[op].description,
    input:
      op === "thread.link_pr" || op === "thread.unlink_pr"
        ? z
            .strictObject(shape)
            .superRefine((input, context) => {
              const parsed = schema.safeParse({ ...input, op });
              if (!parsed.success)
                for (const issue of parsed.error.issues)
                  context.addIssue({ code: "custom", message: issue.message, path: issue.path });
            })
            .meta({ "x-ace-constraint": schema.meta()?.["x-ace-constraint"] })
        : z.strictObject(shape),
    output: AgentControlResult,
    capability:
      controlActions[op].riskClass === "read-only"
        ? null
        : op === "automation.manage"
          ? ("automations" as const)
          : op.startsWith("project.")
            ? ("projects" as const)
            : op === "delegate_task"
              ? ("agents" as const)
              : ("thread_control" as const),
    timeoutMs: op === "delegate_task" || op === "thread.wait" ? 300000 : 10000,
  };
});
export function agentControlToolkit(port: AgentControlPort): Toolkit {
  return {
    register(registry) {
      for (const definition of agentControlToolCatalog)
        registry.register({
          ...definition,
          async run(input: z.output<typeof definition.input>, context) {
            const operation = AgentControlOperation.parse({ ...input, op: definition.op });
            return port.execute(context.caller, operation, context.signal);
          },
        });
    },
  };
}
