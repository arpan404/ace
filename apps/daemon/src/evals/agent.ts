import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { canonicalJson, summarize, type TraceCall, type TraceContext } from "./trace.ts";

/** One MCP tool as the server advertises it. */
export const ListedTool = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ListedTool = z.infer<typeof ListedTool>;
const ContentItem = z
  .object({ type: z.string(), text: z.string().optional(), data: z.string().optional() })
  .passthrough();
export interface CallResult {
  readonly failed: boolean;
  readonly text: string;
  /** Parsed `structuredContent`, or the first text block parsed as JSON. */
  readonly data: unknown;
}

/**
 * A scripted "model": it talks to the real ace MCP endpoint through the official client, the way
 * a provider CLI would, and records only what a model could see. Policies decide what to call.
 */
export class EvalAgent {
  readonly calls: TraceCall[] = [];
  turns = 0;
  tools: ListedTool[] = [];
  private readonly client: Client;
  readonly instructions: string;
  /** MCP server instructions as served, whether or not this provider reads them. */
  readonly serverInstructions: string;
  private constructor(client: Client, instructions: string, serverInstructions: string) {
    this.client = client;
    this.instructions = instructions;
    this.serverInstructions = serverInstructions;
  }

  /**
   * `nativeInstructions` is the provider's own system/developer channel. `serverInstructions`
   * is false for providers that opt out of MCP server instructions (`X-Ace-Instructions: native`).
   */
  static async connect(input: {
    url: string;
    bearer: string;
    nativeInstructions: string;
    serverInstructions: boolean;
  }): Promise<EvalAgent> {
    const client = new Client(
      { name: "ace-eval", version: "1" },
      { versionNegotiation: { mode: "legacy" } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(input.url), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${input.bearer}`,
            ...(input.serverInstructions ? {} : { "X-Ace-Instructions": "native" }),
          },
        },
      }),
    );
    const server = input.serverInstructions ? (client.getInstructions() ?? "") : "";
    const agent = new EvalAgent(
      client,
      [server, input.nativeInstructions].filter(Boolean).join("\n\n"),
      server,
    );
    await agent.refreshTools();
    return agent;
  }

  async refreshTools(): Promise<ListedTool[]> {
    const listed = await this.client.listTools();
    this.tools = z.array(ListedTool).parse(listed.tools);
    return this.tools;
  }

  has(name: string): boolean {
    return this.tools.some((tool) => tool.name === name);
  }

  /** One model step. Calls inside it run concurrently, as parallel tool calls would. */
  async turn<T>(step: () => Promise<T>): Promise<T> {
    this.turns++;
    return step();
  }

  async call(tool: string, args: Record<string, unknown>): Promise<CallResult> {
    const turn = this.turns;
    let failed: boolean;
    let text: string;
    let data: unknown;
    try {
      const result = await this.client.callTool({ name: tool, arguments: args });
      const items = z.array(ContentItem).parse(result.content ?? []);
      text = items.map((item) => item.text ?? item.data ?? "").join("\n");
      data = result.structuredContent ?? parseJson(items.find((item) => item.text)?.text);
      failed =
        result.isError === true ||
        z.object({ ok: z.literal(false) }).safeParse(result.structuredContent).success;
    } catch (error) {
      // A protocol-level rejection still reaches the model as an error string.
      text = error instanceof Error ? error.message : "Tool call failed";
      data = undefined;
      failed = true;
    }
    this.calls.push({ turn, tool, args: canonicalJson(args), resultText: text, failed });
    return { failed, text, data };
  }

  /** The model uses its own tool (for example `git branch` in its shell); only its output is seen. */
  ownTool(tool: string, args: Record<string, unknown>, resultText: string): string {
    this.calls.push({
      turn: this.turns,
      tool,
      args: canonicalJson(args),
      resultText,
      failed: false,
      native: true,
    });
    return resultText;
  }

  context(): TraceContext {
    return {
      instructions: this.instructions,
      toolDescriptors: JSON.stringify(
        this.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      ),
    };
  }

  /** The final answer is one more model turn. */
  finish(success: boolean) {
    return summarize(this.context(), this.calls, this.turns + 1, success);
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
