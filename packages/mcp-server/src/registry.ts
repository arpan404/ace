import { inputTooLarge, parseToolArguments, toolFailure } from "./tool-failure.ts";
import { PublicToolError } from "./public-error.ts";
import { maxStructuredResultBytes } from "./result-budgets.ts";
import { maxToolTimeoutMs } from "./timeouts.ts";
import { describeAceAction } from "./action-target.ts";
import { z } from "zod";
import { executeContent, type ContentToolDefinition } from "./content-tools.ts";
import type { McpAttribution, McpCapability } from "@ace/protocol";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { withinJsonBudget, ResultBudgetExceeded } from "./json-budget.ts";
import { advertisedInputSchema, advertisedOutputSchema } from "./advertised-schema.ts";
import type { Principal } from "./credentials.ts";
import {
  bareToolName,
  defaultToolTitle,
  defaultToolset,
  dispatchedAceCall,
  toolNamePattern,
} from "./tool-names.ts";
import type { ToolListing } from "./toolsets.ts";

/** A tool this session could call, with the guide topic of its family. */
export interface CatalogTool {
  readonly tool: Tool;
  readonly family: string | undefined;
}
/** What the server lends the meta tools (`tools_find`, `tools_call`) about the calling session. */
export interface SessionTools {
  /** How this client lists tools. */
  readonly listing: ToolListing;
  /** Every tool this session could call directly, meta tools excluded. */
  catalog(): readonly CatalogTool[];
  /**
   * Runs a tool exactly as this session calling it directly would. Present only where the
   * client never reloads its list, the one place `tools_call` is offered.
   */
  readonly dispatch?:
    | ((name: string, input: unknown, signal: AbortSignal) => Promise<CallToolResult>)
    | undefined;
}

export interface ToolContext {
  readonly caller: McpAttribution;
  readonly capabilities: readonly McpCapability[];
  readonly signal: AbortSignal;
  /**
   * How the client lists tools (`toolsets.ts`). Where it does not list every tool, a guide also
   * returns its family's schemas inline.
   */
  readonly listing?: ToolListing;
  /** Set by the server for the meta tools only. */
  readonly session?: SessionTools;
}
export type CallObserver = (
  name: string,
  input: unknown,
  context: ToolContext,
) => ((result: CallToolResult) => Promise<void>) | undefined;

/**
 * Records a tool failure whose cause stays private (an unexpected error, not a PublicToolError)
 * and returns the id of that record, which the agent's result carries.
 */
export type ToolFailureReporter = (failure: {
  tool: string;
  caller: McpAttribution;
  error: unknown;
}) => string | undefined;
type RiskClass = import("@ace/protocol").ApprovalTarget["riskClass"];
/** What every registration shares: identity, annotations and placement. */
export interface ToolMetadata {
  /** Bare lowercase snake case: the server name `ace` is the namespace (`tool-names.ts`). */
  name: string;
  /** The human-readable name clients show; defaults to the name in words. */
  title?: string;
  description: string;
  riskClass?: RiskClass;
  /** Deletes, overwrites or spends: the only ace tools a provider should gate itself. */
  destructive?: boolean;
  /** Reaches past this machine (the web, a remote service). Defaults to external-effect risk. */
  openWorld?: boolean;
  /** The guide topic whose family this tool belongs to. Tools without one are always listed. */
  toolset?: string;
  capability: McpCapability | null;
  timeoutMs: number;
}
export interface ToolDefinition<I extends z.ZodObject, O extends z.ZodObject> extends ToolMetadata {
  input: I;
  output: O;
  /**
   * The output schema clients see, when the validated one is too large to be worth its context.
   * It must accept every value `output` accepts (use open objects). `null` advertises none:
   * for a shape that would tell a model nothing it does not read in the result itself.
   */
  advertisedOutput?: z.ZodObject | null;
  /** Trusted definition override; ordinary tools remain capped at 64 KiB. */
  maxInputBytes?: number;
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
/**
 * Claude Code defers MCP tools behind tool search; these stay loaded because the instructions
 * name them as entry points: project context, the guides, delegation and its wait, a page in
 * ace's browser, a visual inline and the search for the rest. Every upfront tool costs context on every request, so keep
 * this short. Other clients ignore the key. Compared by bare name.
 */
const alwaysLoadedTools: ReadonlySet<string> = new Set([
  "context",
  "guide",
  "delegate",
  "wait",
  "browser_open",
  "html_render",
  "tools_find",
]);
function noop(): void {}
interface Entry {
  name: string;
  toolset: string | undefined;
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
  /** Bare name to registered name, so every provider spelling of a tool reaches it. */
  private bare = new Map<string, string>();
  private active = 0;
  private activeThreads = new Map<string, number>();
  private scheduler: Scheduler;
  private maxTools: number;
  private maxCalls: number;
  private maxCallsPerThread: number;
  private availability:
    | ((caller: McpAttribution) => (name: string, capability: McpCapability | null) => boolean)
    | undefined;
  readonly observeCall: CallObserver | undefined;
  private reportFailure: ToolFailureReporter | undefined;
  constructor(options: {
    scheduler: Scheduler;
    maxTools?: number;
    maxCalls?: number;
    maxCallsPerThread?: number;
    observeCall?: CallObserver;
    reportFailure?: ToolFailureReporter;
  }) {
    this.scheduler = options.scheduler;
    this.observeCall = options.observeCall;
    this.reportFailure = options.reportFailure;
    this.maxTools = options.maxTools ?? 128;
    // Waits hold a call for up to ten minutes, so these bound runaway work, not normal fan-out:
    // a parent waiting on many children still has room for every other tool.
    this.maxCalls = options.maxCalls ?? 1024;
    this.maxCallsPerThread = options.maxCallsPerThread ?? 256;
  }
  register<I extends z.ZodObject, O extends z.ZodObject>(definition: ToolDefinition<I, O>): void {
    const { name, description, input, output } = definition;
    this.add(
      definition,
      this.descriptor(
        definition,
        input,
        definition.advertisedOutput === null ? undefined : (definition.advertisedOutput ?? output),
      ),
      {
        action(value) {
          const parsed = input.safeParse(value);
          return parsed.success
            ? describeAceAction(name, description, definition.riskClass, parsed.data)
            : undefined;
        },
        async execute(value, context) {
          const maxInput = definition.maxInputBytes ?? 64 * 1024;
          if (!withinJsonBudget(value, maxInput)) throw inputTooLarge(maxInput);
          const args = parseToolArguments(input, value);
          context.signal.throwIfAborted();
          const result = await definition.run(args, context);
          if (!withinJsonBudget(result, maxStructuredResultBytes)) throw new ResultBudgetExceeded();
          const structuredContent = output.parse(result);
          const text = JSON.stringify(structuredContent);
          if (Buffer.byteLength(text) > maxStructuredResultBytes) throw new ResultBudgetExceeded();
          return { content: [{ type: "text", text }], structuredContent };
        },
      },
    );
  }
  registerContent<I extends z.ZodType>(definition: ContentToolDefinition<I>): void {
    const { name, description, input } = definition;
    this.add(definition, this.descriptor(definition, input), {
      action(value) {
        const parsed = input.safeParse(value);
        return parsed.success
          ? describeAceAction(name, description, definition.riskClass, parsed.data)
          : undefined;
      },
      execute: (value, context) => executeContent(definition, value, context),
    });
  }
  private add(
    metadata: ToolMetadata,
    descriptor: () => Tool,
    behaviour: Pick<Entry, "action" | "execute">,
  ): void {
    this.entries.set(metadata.name, {
      name: metadata.name,
      toolset: metadata.toolset ?? defaultToolset(metadata.name),
      capability: metadata.capability,
      timeoutMs: metadata.timeoutMs,
      descriptor,
      ...behaviour,
    });
    this.bare.set(bareToolName(metadata.name), metadata.name);
  }
  private descriptor(metadata: ToolMetadata, input: z.ZodType, output?: z.ZodObject): () => Tool {
    const { name, capability, timeoutMs } = metadata;
    if (
      !toolNamePattern.test(name) ||
      (name.startsWith("browser_") && capability !== "browser") ||
      (name.startsWith("screen_") && capability !== "screen") ||
      (name.startsWith("sim_") && capability !== "devices") ||
      this.bare.has(bareToolName(name))
    )
      throw new Error("Invalid or duplicate tool name");
    if (this.entries.size >= this.maxTools) throw new Error("Tool capacity reached");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxToolTimeoutMs)
      throw new Error("Invalid tool timeout");
    let built: Tool | undefined;
    return () => (built ??= this.build(metadata, input, output));
  }
  /**
   * Built from trusted definitions and Zod-generated JSON schemas, without loading the MCP SDK;
   * the SDK validates the wire representation when an MCP client connects.
   */
  private build(metadata: ToolMetadata, input: z.ZodType, output?: z.ZodObject): Tool {
    const { name, description, timeoutMs, destructive } = metadata;
    const risk = metadata.riskClass ?? "external-effect";
    const title = metadata.title ?? defaultToolTitle(name);
    const inputSchema = JsonObjectSchema.parse(
      advertisedInputSchema({ ...z.toJSONSchema(input, { io: "input" }), type: "object" }),
    );
    const properties = z.record(z.string(), z.unknown()).safeParse(inputSchema["properties"]).data;
    return {
      name,
      title,
      description,
      // MCP reads a missing destructiveHint as true, so every tool states every hint, even one
      // registered without a risk class.
      annotations: {
        title,
        readOnlyHint: risk === "read-only",
        destructiveHint: destructive === true,
        // Reads change nothing; a stable requestId makes a repeated call a no-op.
        idempotentHint: risk === "read-only" || properties?.["requestId"] !== undefined,
        openWorldHint: metadata.openWorld ?? risk === "external-effect",
      },
      _meta: {
        "ace/timeoutMs": timeoutMs,
        "ace/riskClass": risk,
        ...(alwaysLoadedTools.has(bareToolName(name)) ? { "anthropic/alwaysLoad": true } : {}),
      },
      inputSchema,
      ...(output
        ? {
            outputSchema: JsonObjectSchema.parse(
              advertisedOutputSchema({
                ...z.toJSONSchema(output, { io: "output" }),
                type: "object",
              }),
            ),
          }
        : {}),
    };
  }
  /** A private cause goes to the host's log; the agent gets only the record's id. */
  private report(tool: string, caller: McpAttribution, error: unknown): string | undefined {
    if (error instanceof PublicToolError || !this.reportFailure) return undefined;
    try {
      return this.reportFailure({ tool, caller, error });
    } catch {
      return undefined;
    }
  }
  /** The entry any provider spelling of a tool name refers to. */
  private entry(name: string): Entry | undefined {
    const exact = this.entries.get(name);
    if (exact) return exact;
    const registered = this.bare.get(bareToolName(name));
    return registered === undefined ? undefined : this.entries.get(registered);
  }
  /** The approval target of a call; a `tools_call` reads as the call it runs. */
  action(name: string, input: unknown) {
    const call = dispatchedAceCall(name, input);
    return this.entry(call.name)?.action(call.input);
  }
  capability(name: string): McpCapability | null | undefined {
    return this.entry(name)?.capability;
  }
  /** The guide topic a tool's family belongs to, if it has one. */
  toolset(name: string): string | undefined {
    return this.entry(name)?.toolset;
  }
  capabilities(): ReadonlySet<McpCapability> {
    return new Set(
      [...this.entries.values()].flatMap((entry) => (entry.capability ? [entry.capability] : [])),
    );
  }
  setAvailability(
    read: (caller: McpAttribution) => (name: string, capability: McpCapability | null) => boolean,
  ): void {
    this.availability = read;
  }
  private offered(
    entry: Entry,
    caller: McpAttribution,
    capabilities: readonly McpCapability[],
  ): boolean {
    return (
      (entry.capability === null || capabilities.includes(entry.capability)) &&
      (this.availability?.(caller)(entry.name, entry.capability) ?? true)
    );
  }
  private allowed(entry: Entry, principal: Principal): boolean {
    return this.offered(entry, principal.scope, principal.scope.capabilities);
  }
  names(): string[] {
    return [...this.entries.keys()];
  }
  list(principal: Principal): Tool[] {
    if (principal.signal.aborted) return [];
    const tools: Tool[] = [];
    const availability = this.availability?.(principal.scope);
    for (const [name, entry] of this.entries)
      if (
        (entry.capability === null || principal.scope.capabilities.includes(entry.capability)) &&
        (availability?.(name, entry.capability) ?? true)
      )
        tools.push(entry.descriptor());
    return tools;
  }
  /** The descriptors of a family's tools this caller is offered, for a guide to return inline. */
  describe(toolset: string, context: ToolContext): Tool[] {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.toolset === toolset && this.offered(entry, context.caller, context.capabilities),
      )
      .map((entry) => entry.descriptor());
  }
  inputSchema(name: string, principal: Principal): Record<string, unknown> | undefined {
    const entry = this.entry(name);
    return !principal.signal.aborted && entry && this.allowed(entry, principal)
      ? entry.descriptor().inputSchema
      : undefined;
  }
  async call(
    name: string,
    input: unknown,
    principal: Principal,
    requestSignal: AbortSignal,
    options: { listing?: ToolListing; session?: SessionTools } = {},
  ): Promise<CallToolResult> {
    if (principal.signal.aborted) return failure("Session ended");
    const { sessionId, threadId, agentId } = principal.scope;
    const controller = new AbortController();
    const signal = AbortSignal.any([principal.signal, requestSignal, controller.signal]);
    const context: ToolContext = {
      caller: { sessionId, threadId, agentId },
      capabilities: principal.scope.capabilities,
      signal,
      ...(options.listing ? { listing: options.listing } : {}),
      ...(options.session ? { session: options.session } : {}),
    };
    const observe = this.observeCall?.(name, input, context);
    const finish = async (result: CallToolResult) => {
      // Evidence storage must not change a completed action's public outcome.
      try {
        await observe?.(result);
      } catch {
        /* The host observer owns diagnostics. */
      }
      return result;
    };
    const entry = this.entry(name);
    if (!entry || !this.allowed(entry, principal))
      return finish(toolFailure(new PublicToolError("tool_unavailable")));
    if (
      this.active >= this.maxCalls ||
      (this.activeThreads.get(threadId) ?? 0) >= this.maxCallsPerThread
    )
      return finish(failure("Tool capacity reached"));
    if (signal.aborted) return finish(failure("Tool cancelled"));
    this.active++;
    this.activeThreads.set(threadId, (this.activeThreads.get(threadId) ?? 0) + 1);
    let executionSettled = false;
    let observationSettled = false;
    const release = () => {
      if (executionSettled && observationSettled) {
        this.active--;
        const remaining = (this.activeThreads.get(threadId) ?? 1) - 1;
        if (remaining) this.activeThreads.set(threadId, remaining);
        else this.activeThreads.delete(threadId);
      }
    };
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
    const executing = Promise.resolve()
      .then(() => entry.execute(input, { ...context, signal }))
      .catch((error: unknown) =>
        error instanceof ResultBudgetExceeded
          ? failure("Tool result too large")
          : toolFailure(error, this.report(entry.name, context.caller, error)),
      )
      .finally(() => {
        executionSettled = true;
        release();
      });
    // An uncooperative backend retains its slot until it settles, bounding detached work.
    try {
      return await finish(await Promise.race([executing, stopped]));
    } finally {
      stopTimer();
      stopAbort();
      observationSettled = true;
      release();
    }
  }
}
