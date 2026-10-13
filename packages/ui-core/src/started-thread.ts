import type { Item, ProviderKind, RawPayload } from "@ace/protocol";
import { field, mcpResultParts } from "./mcp-result.ts";
import { providerNames } from "./providers.ts";

/*
 * A conversation an agent started with ace's `ace_thread_start` tool, read from the call: the new
 * thread's id from ace's answer, and its title, provider, model and account from the answer or,
 * for answers that only carry the id, from the call's arguments. Provider payloads are searched
 * with the same bounds as every MCP result. Pure.
 */

export interface StartedThread {
  threadId: string;
  title: string | undefined;
  provider: ProviderKind | undefined;
  model: string | undefined;
  /** The account's label, as the person named it ("360", "Personal"). */
  account: string | undefined;
}

/** Claude's `mcp__ace__ace_thread_start`, OpenCode's `ace_ace_thread_start`, or the bare name. */
const toolName = /^(?:mcp__ace__)?(?:ace_)?ace_thread_start$/;

/** Whether an item is a call of `ace_thread_start`, in any provider's naming. */
export function isThreadStartCall(item: Item | undefined): boolean {
  if (item?.type !== "tool_call") return false;
  const { detail, title } = item.call;
  if (detail.kind === "mcp") return toolName.test(detail.tool);
  return detail.kind === "custom" && toolName.test(title.trim());
}

const text = (value: unknown, max = 256): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;

const isProvider = (value: string): value is ProviderKind => Object.hasOwn(providerNames, value);
const provider = (value: unknown): ProviderKind | undefined =>
  typeof value === "string" && isProvider(value) ? value : undefined;

/** The `data` of ace's `{ ok: true, data }` answer, typed or as JSON text. */
function answerData(result: unknown, raw: readonly RawPayload[]): unknown {
  const typed = field(field(result, "structuredContent"), "data");
  if (field(field(result, "structuredContent"), "ok") === true && typed) return typed;
  const payloads: RawPayload[] =
    result === undefined ? [...raw] : [{ type: "result", data: result }, ...raw];
  for (const part of mcpResultParts(payloads, 0).texts) {
    const trimmed = part.trimStart();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (field(parsed, "ok") === true && field(parsed, "data")) return field(parsed, "data");
    } catch {
      // Provider text that only looks like JSON.
    }
  }
  return undefined;
}

/** The arguments the agent called with: MCP's own, else the first found in the raw payloads. */
function argumentsOf(item: Extract<Item, { type: "tool_call" }>): unknown {
  const { detail, raw } = item.call;
  if (detail.kind === "mcp") return detail.arguments;
  for (const payload of raw) {
    const data = field(payload, "data");
    const input =
      field(field(data, "state"), "input") ?? field(data, "input") ?? field(data, "args");
    if (typeof input === "object" && input !== null) return input;
  }
  return undefined;
}

/** The thread an `ace_thread_start` call started, once ace answered with its id. */
export function startedThreadOf(item: Item | undefined): StartedThread | undefined {
  if (item?.type !== "tool_call" || !isThreadStartCall(item)) return undefined;
  if (item.call.status !== "succeeded") return undefined;
  const result: unknown = Reflect.get(item.call, "result");
  if (field(result, "isError") === true) return undefined;
  const data = answerData(result, item.call.raw);
  const threadId = text(field(data, "threadId"));
  if (!threadId) return undefined;
  const args = argumentsOf(item);
  return {
    threadId,
    title: text(field(data, "title")) ?? text(field(args, "title")),
    provider: provider(field(data, "provider")) ?? provider(field(args, "provider")),
    model: text(field(data, "model")) ?? text(field(args, "model")),
    account: text(field(data, "account"), 64),
  };
}
