import { aceToolInput } from "@ace/core";
import type { Item, ProviderKind, RawPayload } from "@ace/protocol";
import { field, mcpResultParts } from "./mcp-result.ts";
import { providerNames } from "./providers.ts";

/*
 * A conversation an agent started with ace's `thread_start` tool, read from the call: the new
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
  /** A fork of a thread rather than a new one. */
  forked: boolean;
}

/** The ace tools that open a thread: starting one, or forking one. */
type Opening = "thread_start" | "thread_fork";
const isOpening = (name: string): name is Opening =>
  name === "thread_start" || name === "thread_fork";
/** Claude's `mcp__ace__thread_start` or OpenCode's and Pi's `ace_thread_fork`. */
const namespaced = /^(?:mcp__ace__|ace_)(?:ace_)*(thread_(?:start|fork))$/;

/** A start or fork reached through `tools_call`, the only route some clients have to it. */
function dispatchedOpening(call: Extract<Item, { type: "tool_call" }>["call"]) {
  const called = aceToolInput(call);
  return called && isOpening(called.name) ? { ...called, name: called.name } : undefined;
}

/**
 * Which of ace's thread-opening tools an item calls, in any provider's naming or through
 * `tools_call`. The bare name counts only from ace's own server: another server may have a
 * `thread_start` of its own.
 */
function openingTool(item: Extract<Item, { type: "tool_call" }>): Opening | undefined {
  const { detail, title } = item.call;
  const named =
    detail.kind === "mcp"
      ? (namespaced.exec(detail.tool)?.[1] ??
        (/^ace$|^ace[-_]/.test(detail.server) ? detail.tool : undefined))
      : detail.kind === "custom"
        ? namespaced.exec(title.trim())?.[1]
        : undefined;
  return named && isOpening(named) ? named : dispatchedOpening(item.call)?.name;
}

/** Whether an item calls ace's `thread_start` or `thread_fork`. */
export function isThreadStartCall(item: Item | undefined): boolean {
  return item?.type === "tool_call" && openingTool(item) !== undefined;
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
  const dispatched = dispatchedOpening(item.call);
  if (dispatched) return dispatched.input;
  if (detail.kind === "mcp") return detail.arguments;
  for (const payload of raw) {
    const data = field(payload, "data");
    const input =
      field(field(data, "state"), "input") ?? field(data, "input") ?? field(data, "args");
    if (typeof input === "object" && input !== null) return input;
  }
  return undefined;
}

/** The thread a `thread_start` or `thread_fork` call opened, once ace answered with its id. */
export function startedThreadOf(item: Item | undefined): StartedThread | undefined {
  const tool = item?.type === "tool_call" ? openingTool(item) : undefined;
  if (item?.type !== "tool_call" || !tool) return undefined;
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
    forked: tool === "thread_fork",
  };
}
