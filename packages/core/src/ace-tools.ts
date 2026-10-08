import { z } from "zod";
import type { ToolCallDraft } from "./facts.ts";
import type { ToolCall, RawPayload, InteractionRequest } from "@ace/protocol";
type CallInput = {
  detail?: unknown;
  kind?: string;
  title?: string;
  raw?: RawPayload[];
  error?: string | undefined;
};

const record = z.record(z.string(), z.unknown());
const screen = new Set([
  "screenshot",
  "click",
  "type",
  "paste",
  "key",
  "scroll",
  "ui_tree",
  "ui_find",
  "ui_act",
  "measure_interaction",
  "request_app",
  "open_app",
  "request_foreground",
]);

/** Provider namespaces wrap the same daemon tool names. Other servers are never reclassified. */
export function aceToolName(name: string): string | undefined {
  if (name.startsWith("mcp__ace__")) name = name.slice(10);
  if (
    name.startsWith("ace_screen_") ||
    name.startsWith("ace_device_") ||
    name.startsWith("ace_ace_") ||
    name === "ace_delegate_task"
  )
    name = name.slice(4);
  if (name.startsWith("screen_") && screen.has(name.slice(7))) return name;
  if (/^(?:ace_|device_)[a-z0-9_]{1,100}$/.test(name) || name === "delegate_task") return name;
  return undefined;
}

export function aceToolInput(call: CallInput): { name: string; input: unknown } | undefined {
  const detail = z
    .object({
      kind: z.string(),
      server: z.string().optional(),
      tool: z.string().optional(),
      arguments: z.unknown().optional(),
    })
    .safeParse(call.detail).data;
  if (detail?.kind === "mcp") {
    if (!["ace", "unknown", ""].includes(detail.server ?? "")) return;
    const name = aceToolName(detail.tool ?? "");
    if (name) return { name, input: detail.arguments ?? {} };
  }
  if (detail?.kind !== "custom" && call.kind !== "custom") return;
  const title = aceToolName(call.title ?? "");
  const pending: { value: unknown; depth: number; inputJson?: boolean }[] = (call.raw ?? [])
    .toReversed()
    .flatMap((raw) => ("data" in raw ? [{ value: raw.data, depth: 0 }] : []));
  for (let visited = 0; pending.length && visited < 64; visited++) {
    const entry = pending.shift();
    if (!entry) break;
    const parsed = record.safeParse(entry.value);
    if (!parsed.success) continue;
    const data = parsed.data;
    const label = [data.toolName, data.name, data.nativeName, data.title, data["_toolName"]].find(
      (value) => typeof value === "string" && aceToolName(value),
    );
    const name = typeof label === "string" ? aceToolName(label) : title;
    let input =
      data.arguments ??
      data.args ??
      data.input ??
      data.rawInput ??
      data.currentInput ??
      record.safeParse(data.state).data?.input;
    if (
      input === undefined &&
      name &&
      entry.inputJson &&
      typeof data.text === "string" &&
      data.text.length <= 65_536
    ) {
      try {
        input = record.safeParse(JSON.parse(data.text)).data;
      } catch {
        /* Partial input remains raw. */
      }
    }
    if (name && input !== undefined) {
      const wrapped = record.safeParse(input);
      return { name, input: wrapped.success ? (wrapped.data.args ?? input) : input };
    }
    if (entry.depth < 5)
      for (const key of ["initialFrame", "toolCall", "update", "params", "body", "data"])
        if (data[key] !== undefined)
          pending.unshift({
            value: data[key],
            depth: entry.depth + 1,
            inputJson: data.type === "session.tool.input.ended",
          });
  }
  return title ? { name: title, input: {} } : undefined;
}

export function privateAceInput(name: string, input?: unknown): boolean {
  const payload = record.safeParse(input).data;
  const action = record.safeParse(payload?.action ?? payload?.interaction).data;
  if (name.endsWith("measure_interaction") && action && ("text" in action || "value" in action))
    return true;
  return [
    "screen_type",
    "screen_paste",
    "screen_ui_act",
    "device_type",
    "device_ui_act",
    "device_act",
    "ace_browser_type",
    "ace_browser_fill",
  ].includes(name);
}
export function redactAceArguments(name: string, value: unknown): unknown {
  if (!privateAceInput(name, value)) return value;
  const parsed = record.safeParse(value);
  if (!parsed.success) return { redacted: true };
  const redacted = Object.fromEntries(
    Object.entries(parsed.data).map(([key, child]) => [
      key,
      ["text", "value"].includes(key) ? "[redacted]" : child,
    ]),
  );
  for (const field of ["action", "interaction"]) {
    const action = record.safeParse(redacted[field]);
    if (action.success)
      redacted[field] = Object.fromEntries(
        Object.entries(action.data).map(([key, child]) => [
          key,
          ["text", "value"].includes(key) ? "[redacted]" : child,
        ]),
      );
  }
  return redacted;
}

/** Conservative text-input redaction happens before raw payloads can be exported or snapshotted. */
export function normalizeAceCall(call: ToolCall): ToolCall;
export function normalizeAceCall(call: ToolCallDraft, previous?: ToolCall): ToolCallDraft;
export function normalizeAceCall(call: CallInput, previous?: ToolCall): CallInput {
  if (previous?.detail.kind === "mcp") {
    const incoming = aceToolInput(call);
    call = { kind: previous.kind, title: previous.title, detail: previous.detail, ...call };
    if (
      incoming &&
      record.safeParse(incoming.input).success &&
      Object.keys(record.parse(incoming.input)).length === 0
    )
      call = { ...call, detail: previous.detail };
  }
  const tool = aceToolInput(call);
  if (!tool) return call;
  return {
    ...call,
    kind: "mcp",
    detail: {
      kind: "mcp",
      server: "ace",
      tool: tool.name,
      arguments: redactAceArguments(tool.name, tool.input),
    },
    ...(privateAceInput(tool.name, tool.input)
      ? {
          title: tool.name,
          ...(call.error ? { error: "Ace input failed" } : {}),
          raw: [{ type: "ace.private-input", data: { redacted: true } }],
        }
      : {}),
  };
}

/** Approval previews can also echo private input or nested measured actions. */
export function redactAceApproval(request: InteractionRequest): InteractionRequest {
  if (request.kind !== "approval" || !request.target) return request;
  const target = request.target;
  const name = aceToolName(target.tool);
  const owned =
    target.origin === "ace" ||
    target.tool.startsWith("mcp__ace__") ||
    request.mcpServer?.name === "ace";
  if (!owned || !name || !privateAceInput(name, target.input)) return request;
  return {
    ...request,
    title: "Approve computer input",
    description: "Input content is redacted.",
    target: {
      ...target,
      input: redactAceArguments(name, target.input),
      description: "Input content is redacted.",
    },
  };
}
