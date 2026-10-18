import { z } from "zod";
import { bareToolName } from "@ace/provider-kit/ace-tool-names";
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
  "open_app",
  "request_foreground",
]);

const namespaced = /^(?:mcp__ace__|ace_)/;
const toolName = /^[a-z][a-z0-9_]{0,100}$/;

/**
 * The bare name of an un-namespaced call (a provider `custom` call or a title) when it is one of
 * ace's: it carries ace's namespace (`mcp__ace__`, `ace_`) or is a computer-use or device tool,
 * which some providers report bare. Any other bare name belongs to someone else.
 */
export function aceToolName(name: string): string | undefined {
  const bare = bareToolName(name);
  if (!toolName.test(bare)) return undefined;
  if (namespaced.test(name)) return bare;
  if (bare.startsWith("screen_") && screen.has(bare.slice(7))) return bare;
  return bare.startsWith("device_") ? bare : undefined;
}

/** The tool an MCP detail names, when the server is ace's or the provider did not report one. */
function aceMcpToolName(server: string | undefined, tool: string | undefined): string | undefined {
  if (!["ace", "unknown", ""].includes(server ?? "")) return undefined;
  const bare = bareToolName(tool ?? "");
  return toolName.test(bare) ? bare : undefined;
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
    const name = aceMcpToolName(detail.server, detail.tool);
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

/** Whether a call's input is typed text or markup that must never be stored. Any spelling. */
export function privateAceInput(tool: string, input?: unknown): boolean {
  const name = bareToolName(tool);
  const payload = record.safeParse(input).data;
  const action = record.safeParse(payload?.action ?? payload?.interaction).data;
  if (name.endsWith("measure_interaction") && action && ("text" in action || "value" in action))
    return true;
  return [
    "html_render",
    "screen_type",
    "screen_paste",
    "screen_ui_act",
    "device_type",
    "device_ui_act",
    "device_act",
    "browser_type",
    "browser_fill",
  ].includes(name);
}
export function redactAceArguments(name: string, value: unknown): unknown {
  if (!privateAceInput(name, value)) return value;
  const parsed = record.safeParse(value);
  if (!parsed.success) return { redacted: true };
  const redacted = Object.fromEntries(
    Object.entries(parsed.data).map(([key, child]) => [
      key,
      ["text", "value", "html", "title"].includes(key) ? "[redacted]" : child,
    ]),
  );
  for (const field of ["action", "interaction"]) {
    const action = record.safeParse(redacted[field]);
    if (action.success)
      redacted[field] = Object.fromEntries(
        Object.entries(action.data).map(([key, child]) => [
          key,
          ["text", "value", "html", "title"].includes(key) ? "[redacted]" : child,
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
  const owned =
    target.origin === "ace" ||
    target.tool.startsWith("mcp__ace__") ||
    request.mcpServer?.name === "ace";
  const name = owned ? bareToolName(target.tool) : undefined;
  if (!name || !privateAceInput(name, target.input)) return request;
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
