import type { Toolkit } from "@ace/mcp-server";
import { SpadeToolCallInput, type ThreadId } from "@ace/protocol";
import { maxToolTimeoutMs } from "@ace/mcp-server";
import { spadeBridgeTools } from "@ace/provider-kit/ace-tool-names";
import { z } from "zod";
import { spadeRequest, type SpadeConnection } from "./forward.ts";

/** The two tools a bot's hidden session gets for the bot's own tools (ADR 0133). */
export const spadeBrainToolNames = spadeBridgeTools;

/**
 * Everything a bot's session is offered of ace's (ADR 0133): the bridge to the bot's gated
 * tools, ace's reads that return only ace's own state, and the means to find and call those. Any
 * other ace tool would act or read outside text with no gate, since nobody answers a prompt
 * there; `ask` is withheld separately (`askAvailable`).
 */
export const spadeBotAceTools: readonly string[] = [
  ...spadeBridgeTools,
  "machines",
  "models",
  "projects_find",
  "automations_list",
  "guide",
  "tools_find",
  "tools_call",
];

const answer = z.object({ result: z.string(), isError: z.boolean() });

export interface BrainToolsOptions {
  /** The bot a hidden thread thinks for; undefined for every other thread. */
  botOf(threadId: ThreadId): string | undefined;
  /** Spade's API, while it answers. */
  spade(): SpadeConnection | undefined;
  /** How many frames of the bot's running turn precede a call made now (see `SpadeBrains`). */
  streamSeq(threadId: ThreadId): Promise<number | undefined>;
}

/** The `_meta` key telling Spade which frame of the turn's answer a call follows. */
export const streamSeqKey = "dev.acehq.spade/seq";

/**
 * `spade_tools` and `spade_call`, offered only in a Spade bot's hidden session (the MCP service
 * withholds them elsewhere). Each is forwarded with Spade's token to Spade's MCP server for that
 * bot, where the bot's gate decides; a call waits there for the person's approval.
 */
export function spadeBrainToolkit(options: BrainToolsOptions): Toolkit {
  const forward = async (
    threadId: ThreadId,
    method: "tools/list" | "tools/call",
    params: unknown,
    signal: AbortSignal,
  ) => {
    const bot = options.botOf(threadId);
    if (!bot) return { result: "This session belongs to no Spade bot.", isError: true };
    const connection = options.spade();
    if (!connection) return { result: "Spade isn't running.", isError: true };
    const answered = await spadeRequest(
      connection,
      {
        method: "POST",
        path: `/v1/agents/${encodeURIComponent(bot)}/mcp`,
        body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })),
      },
      { signal, maxBytes: 2 * 1024 * 1024 },
    );
    if (answered.kind !== "response" || answered.status !== 200)
      return { result: "Spade didn't answer; the call may not have run.", isError: true };
    return readRpc(answered.body.toString("utf8"));
  };
  return {
    register(registry) {
      registry.register({
        name: "spade_tools",
        title: "Spade tools",
        description:
          "List this bot's own Spade tools (memory, workspace, routines, other bots, connectors, ask_user) with their input schemas. Pass a query to search them.",
        riskClass: "read-only",
        openWorld: false,
        capability: null,
        timeoutMs: 30_000,
        input: z.strictObject({ query: z.string().max(200).optional() }),
        output: answer,
        failed: (result) => result.isError,
        run: (input, { caller, signal }) =>
          forward(caller.threadId, "tools/list", input.query ? { query: input.query } : {}, signal),
      });
      registry.register({
        name: "spade_call",
        title: "Spade call",
        description:
          "Run one of this bot's Spade tools: {tool, arguments}. Spade may ask the person first; the call waits for their answer.",
        riskClass: "external-effect",
        openWorld: true,
        capability: null,
        timeoutMs: maxToolTimeoutMs,
        input: SpadeToolCallInput,
        output: answer,
        failed: (result) => result.isError,
        run: async (input, { caller, signal }) => {
          const seq = await options.streamSeq(caller.threadId);
          return forward(
            caller.threadId,
            "tools/call",
            {
              name: input.tool,
              arguments: input.arguments,
              ...(seq === undefined ? {} : { _meta: { [streamSeqKey]: seq } }),
            },
            signal,
          );
        },
      });
    },
  };
}

const RpcAnswer = z.object({
  result: z
    .object({
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
      isError: z.boolean().default(false),
      tools: z.array(z.unknown()).optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** Spade's JSON-RPC answer as one text result: a tool list as JSON, a call's text parts. */
export function readRpc(body: string): z.infer<typeof answer> {
  let parsed: z.infer<typeof RpcAnswer>;
  try {
    parsed = RpcAnswer.parse(JSON.parse(body));
  } catch {
    return { result: "Spade's answer could not be read.", isError: true };
  }
  if (parsed.error) return { result: parsed.error.message, isError: true };
  const result = parsed.result;
  if (!result) return { result: "Spade sent no result.", isError: true };
  if (result.tools) return { result: JSON.stringify(result.tools), isError: false };
  const text = result.content.map((part) => part.text ?? "").join("\n");
  return { result: text, isError: result.isError };
}
