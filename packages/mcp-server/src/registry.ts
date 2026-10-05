import { parseToolArguments, toolFailure } from "./tool-failure.ts";
import { describeAceAction } from "./actions.ts";
import { z } from "zod";
import { executeContent, type ContentToolDefinition } from "./content-tools.ts";
import type { McpAttribution, McpCapability } from "@ace/protocol";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { withinJsonBudget, ResultBudgetExceeded } from "./json-budget.ts";
import type { Principal } from "./credentials.ts";

export interface ToolContext {
  readonly caller: McpAttribution;
  readonly signal: AbortSignal;
}
export interface ToolDefinition<I extends z.ZodObject, O extends z.ZodObject> {
  name: string;
  riskClass?: import("@ace/protocol").ApprovalTarget["riskClass"];
  description: string;
  input: I;
  output: O;
  capability: McpCapability | null;
  timeoutMs: number;
  run(input: z.output<I>, context: ToolContext): Promise<z.input<O>>;
}
export interface Scheduler {
  after(ms: number, run: () => void): () => void;
}
export const nodeScheduler: Scheduler = {
  after(ms, run) {
    const timer = setTimeout(run, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
const JsonObjectSchema = z.object({ type: z.literal("object") }).passthrough();
function noop(): void {}
interface Entry {
  /** Built on first list or schema read: JSON Schema per tool would otherwise sit idle in heap. */
  descriptor(): Tool;
  action(input: unknown): import("@ace/protocol").ApprovalTarget | undefined;
  capability: McpCapability | null;
  timeoutMs: number;
  execute(input: unknown, context: ToolContext): Promise<CallToolResult>;
}
const failure = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

export class ToolRegistry {
  private entries = new Map<string, Entry>();
  private active = 0;
  private scheduler: Scheduler;
  private maxTools: number;
  private maxCalls: number;
  constructor(options: { scheduler: Scheduler; maxTools?: number; maxCalls?: number }) {
    this.scheduler = options.scheduler;
    this.maxTools = options.maxTools ?? 128;
    this.maxCalls = options.maxCalls ?? 64;
  }
  register<I extends z.ZodObject, O extends z.ZodObject>(definition: ToolDefinition<I, O>): void {
    const { name, description, input, output, capability, timeoutMs } = definition;
    const descriptor = this.descriptor(
      name,
      description,
      input,
      capability,
      timeoutMs,
      output,
      definition.riskClass,
    );
    this.entries.set(name, {
      descriptor,
      capability,
      timeoutMs,
      action(value) {
        const parsed = input.safeParse(value);
        return parsed.success
          ? describeAceAction(name, description, definition.riskClass, parsed.data)
          : undefined;
      },
      async execute(value, context) {
        if (!withinJsonBudget(value, 64 * 1024)) throw new Error("Input budget exceeded");
        const args = parseToolArguments(input, value);
        context.signal.throwIfAborted();
        const result = await definition.run(args, context);
        if (!withinJsonBudget(result, 256 * 1024)) throw new ResultBudgetExceeded();
        const structuredContent = output.parse(result);
        const text = JSON.stringify(structuredContent);
        if (Buffer.byteLength(text) > 256 * 1024) throw new ResultBudgetExceeded();
        return { content: [{ type: "text", text }], structuredContent };
      },
    });
  }
  registerContent<I extends z.ZodType>(definition: ContentToolDefinition<I>): void {
    const { name, description, input, capability, timeoutMs } = definition;
    const descriptor = this.descriptor(
      name,
      description,
      input,
      capability,
      timeoutMs,
      undefined,
      definition.riskClass,
    );
    this.entries.set(name, {
      descriptor,
      capability,
      timeoutMs,
      action(value) {
        const parsed = input.safeParse(value);
        return parsed.success
          ? describeAceAction(name, description, definition.riskClass, parsed.data)
          : undefined;
      },
      execute: (value, context) => executeContent(definition, value, context),
    });
  }
  private descriptor(
    name: string,
    description: string,
    input: z.ZodType,
    capability: McpCapability | null,
    timeoutMs: number,
    output?: z.ZodObject,
    riskClass?: import("@ace/protocol").ApprovalTarget["riskClass"],
  ): () => Tool {
    if (
      (name !== "delegate_task" &&
        !/^ace_[a-z0-9_]{1,100}$/.test(name) &&
        !(capability === "screen" && /^screen_[a-z0-9_]{1,100}$/.test(name)) &&
        !(capability === "devices" && /^device_[a-z0-9_]{1,100}$/.test(name))) ||
      this.entries.has(name)
    )
      throw new Error("Invalid or duplicate tool name");
    if (this.entries.size >= this.maxTools) throw new Error("Tool capacity reached");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
      throw new Error("Invalid tool timeout");
    let built: Tool | undefined;
    return () => (built ??= this.build(name, description, input, timeoutMs, output, riskClass));
  }
  /**
   * Built from trusted definitions and Zod-generated JSON schemas, without loading the MCP SDK;
   * the SDK validates the wire representation when an MCP client connects.
   */
  private build(
    name: string,
    description: string,
    input: z.ZodType,
    timeoutMs: number,
    output?: z.ZodObject,
    riskClass?: import("@ace/protocol").ApprovalTarget["riskClass"],
  ): Tool {
    return {
      name,
      description,
      ...(riskClass
        ? {
            annotations: {
              readOnlyHint: riskClass === "read-only",
              destructiveHint: riskClass === "external-effect",
              openWorldHint: riskClass === "external-effect",
            },
          }
        : {}),
      _meta: { "ace/timeoutMs": timeoutMs, "ace/riskClass": riskClass ?? "external-effect" },
      inputSchema: JsonObjectSchema.parse({
        ...z.toJSONSchema(input, { io: "input" }),
        type: "object",
      }),
      ...(output
        ? {
            outputSchema: JsonObjectSchema.parse({
              ...z.toJSONSchema(output, { io: "output" }),
              type: "object",
            }),
          }
        : {}),
    };
  }
  action(name: string, input: unknown) {
    const tool = name.startsWith("mcp__ace__") ? name.slice("mcp__ace__".length) : name;
    return this.entries.get(tool)?.action(input);
  }
  list(principal: Principal): Tool[] {
    if (principal.signal.aborted) return [];
    const tools: Tool[] = [];
    for (const entry of this.entries.values())
      if (allowed(entry, principal)) tools.push(entry.descriptor());
    return tools;
  }
  inputSchema(name: string, principal: Principal): Record<string, unknown> | undefined {
    const entry = this.entries.get(name);
    return !principal.signal.aborted && entry && allowed(entry, principal)
      ? entry.descriptor().inputSchema
      : undefined;
  }
  async call(
    name: string,
    input: unknown,
    principal: Principal,
    requestSignal: AbortSignal,
  ): Promise<CallToolResult> {
    if (principal.signal.aborted) return failure("Session ended");
    const entry = this.entries.get(name);
    if (!entry || !allowed(entry, principal))
      return failure("Tool unavailable or capability denied");
    if (this.active >= this.maxCalls) return failure("Tool capacity reached");
    const controller = new AbortController();
    const signal = AbortSignal.any([principal.signal, requestSignal, controller.signal]);
    if (signal.aborted) return failure("Tool cancelled");
    this.active++;
    let reason = "Tool cancelled";
    let stopTimer: () => void = noop;
    let stopAbort: () => void = noop;
    const stopped = new Promise<CallToolResult>((resolve) => {
      const abort = () => resolve(failure(reason));
      signal.addEventListener("abort", abort, { once: true });
      stopAbort = () => signal.removeEventListener("abort", abort);
      stopTimer = this.scheduler.after(entry.timeoutMs, () => {
        reason = "Tool timed out";
        controller.abort();
      });
    });
    const { sessionId, threadId, agentId } = principal.scope;
    const executing = entry
      .execute(input, { caller: { sessionId, threadId, agentId }, signal })
      .then((result): CallToolResult => (signal.aborted ? failure(reason) : result))
      .catch((error: unknown) =>
        error instanceof ResultBudgetExceeded
          ? failure("Tool result too large")
          : toolFailure(error),
      )
      .finally(() => {
        this.active--;
      });
    // An uncooperative backend retains its slot until it settles, bounding detached work.
    try {
      return await Promise.race([executing, stopped]);
    } finally {
      stopTimer();
      stopAbort();
    }
  }
}
function allowed(entry: Entry, principal: Principal): boolean {
  return entry.capability === null || principal.scope.capabilities.includes(entry.capability);
}
