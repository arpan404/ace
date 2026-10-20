import { z } from "zod";
import { AgentControlOperation, AgentControlResult, type McpAttribution } from "@ace/protocol";
import { withControlHint } from "./control-hints.ts";
import { maxControlInputBytes } from "./result-budgets.ts";
import type { ToolContext, ToolMetadata, ToolRegistry } from "./registry.ts";

/**
 * The longest bounded wait plus transport grace, still inside every provider's tool timeout.
 * Every control tool gets it: git-backed forks, merges and handoffs in a large repository, and
 * thread starts that prepare a worktree, must not be cut short by a tighter ace deadline.
 */
export const controlToolTimeoutMs = 630_000;

/** The daemon's agent-control owner. Tools translate their input into these operations. */
export interface AgentControlPort {
  execute(
    caller: McpAttribution,
    operation: AgentControlOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult>;
}

/** What a control tool's handler may do: run operations as its caller, with ace's hints. */
export interface Control {
  readonly context: ToolContext;
  run(operation: z.input<typeof AgentControlOperation>): Promise<AgentControlResult>;
}

/**
 * Every control tool answers `{ ok, code?, hint?, data? }`: a failure the agent can act on is a
 * result with a code and a next step, not an exception, and `data` holds the ids to follow up.
 */
export function controlResult<T extends z.ZodType>(data: T) {
  const { data: _open, ...base } = AgentControlResult.shape;
  return z.object({ ...base, data: data.optional() });
}
/** For tools whose success needs no data: ok or a code is the whole answer. */
export const NoData = z.object((({ data: _open, ...base }) => base)(AgentControlResult.shape));

export interface ControlToolDefinition<I extends z.ZodObject> extends ToolMetadata {
  input: I;
  output: z.ZodObject;
  maxInputBytes?: number;
  run(input: z.output<I>, control: Control): Promise<AgentControlResult>;
}
/** A control tool with its input type erased, so families can live in one catalog. */
export interface ControlTool extends ToolMetadata {
  readonly input: z.ZodObject;
  readonly output: z.ZodObject;
  register(registry: ToolRegistry, port: AgentControlPort): void;
}

export function controlTool<I extends z.ZodObject>(
  definition: ControlToolDefinition<I>,
): ControlTool {
  const { run, maxInputBytes, ...metadata } = definition;
  return {
    ...metadata,
    register(registry, port) {
      registry.register({
        ...metadata,
        // The envelope (`ok`, `code`, `hint`, open `data`) told a model nothing the result
        // does not; each tool still validates its own data shape.
        advertisedOutput: null,
        maxInputBytes: maxInputBytes ?? maxControlInputBytes,
        run: (input, context) =>
          run(input, {
            context,
            async run(value) {
              const operation = AgentControlOperation.parse(value);
              return withControlHint(
                operation.op,
                await port.execute(context.caller, operation, context.signal),
              );
            },
          }),
      });
    },
  };
}

/** Shared field descriptions, so every tool explains the same field the same way. */
export const fields = {
  requestId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .describe("Any stable id; repeating a call with it runs once."),
};
