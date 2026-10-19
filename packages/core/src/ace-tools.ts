import { z } from "zod";
import { aceToolDispatch, bareToolName, dispatchedAceCall } from "@ace/provider-kit/ace-tool-names";
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
  "open_app",
  "windows",
  "ui_tree",
  "ui_act",
  "input",
  "screenshot",
  "measure",
  "apps",
  "state",
  "act",
]);

const browser = new Set([
  "open",
  "snapshot",
  "act",
  "wait_for",
  "find",
  "screenshot",
  "logs",
  "evaluate",
  "history",
  "settings",
  "measure",
]);
const sim = new Set(["list", "start", "stop", "ui", "act", "screenshot", "logs"]);
/** Families some providers report without ace's namespace; only ace's own names count. */
const bareFamilies: readonly (readonly [string, ReadonlySet<string>])[] = [
  ["browser_", browser],
  ["screen_", screen],
  ["sim_", sim],
];

const namespaced = /^(?:mcp__ace__|ace_)/;
const toolName = /^[a-z][a-z0-9_]{0,100}$/;

/**
 * The bare name of an un-namespaced call (a provider `custom` call or a title) when it is one of
 * ace's: it carries ace's namespace (`mcp__ace__`, `ace_`) or is a browser, computer-use or sim tool,
 * which some providers report bare. Any other bare name (another server's `browser_click`)
 * belongs to someone else.
 */
export function aceToolName(name: string): string | undefined {
  const bare = bareToolName(name);
  if (!toolName.test(bare)) return undefined;
  if (namespaced.test(name)) return bare;
  return bareFamilies.some(
    ([prefix, names]) => bare.startsWith(prefix) && names.has(bare.slice(prefix.length)),
  )
    ? bare
    : undefined;
}

/** The tool an MCP detail names, when the server is ace's or the provider did not report one. */
function aceMcpToolName(server: string | undefined, tool: string | undefined): string | undefined {
  if (!["ace", "unknown", ""].includes(server ?? "")) return undefined;
  const bare = bareToolName(tool ?? "");
  return toolName.test(bare) ? bare : undefined;
}

/**
 * The ace tool a call ran and its input. A `tools_call` reads as the tool it dispatched, so its
 * row, privacy, evidence and approvals are that tool's.
 */
export function aceToolInput(call: CallInput): { name: string; input: unknown } | undefined {
  const called = calledAceTool(call);
  return called && dispatchedAceCall(called.name, called.input);
}

function calledAceTool(call: CallInput): { name: string; input: unknown } | undefined {
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
  const call = dispatchedAceCall(tool, input);
  const name = bareToolName(call.name);
  const payload = record.safeParse(call.input).data;
  const action = record.safeParse(payload?.action ?? payload?.interaction).data;
  if (name.endsWith("_measure") && action && ("text" in action || "value" in action)) return true;
  if (name === "html_render") return true;
  // A computer-use batch types, pastes, sets or selects document text in some of its steps.
  if (name === "screen_act")
    return (Array.isArray(payload?.actions) ? payload.actions : []).some(privateStep);
  // Merged input tools carry text only for typing, pasting or setting a value; a click or key
  // press stays visible, error and all.
  return (
    ["screen_input", "screen_ui_act", "sim_act", "browser_act"].includes(name) &&
    payload !== undefined &&
    ["text", "value", "promptText"].some((key) => payload[key] !== undefined)
  );
}
/** Computer-use steps that carry typed, pasted, set or selected text, and those fields. */
const textSteps: ReadonlySet<unknown> = new Set(["type", "paste", "set_value", "select_text"]);
const stepSecrets = ["text", "value", "prefix", "suffix"];
function privateStep(entry: unknown): boolean {
  const step = record.safeParse(entry).data;
  return step !== undefined && textSteps.has(step["type"]);
}

export function redactAceArguments(name: string, value: unknown): unknown {
  if (!privateAceInput(name, value)) return value;
  const call = dispatchedAceCall(name, value);
  if (bareToolName(name) === aceToolDispatch && call.name !== name)
    return { ...record.parse(value), arguments: redactAceArguments(call.name, call.input) };
  const parsed = record.safeParse(value);
  if (!parsed.success) return { redacted: true };
  const redacted = Object.fromEntries(
    Object.entries(parsed.data).map(([key, child]) => [
      key,
      ["text", "value", "html", "title", "promptText"].includes(key) ? "[redacted]" : child,
    ]),
  );
  // Search text (wait_for, a step's when) stays visible: it is what the agent looks for.
  if (Array.isArray(redacted.actions))
    redacted.actions = redacted.actions.map((entry) => {
      const step = record.safeParse(entry);
      if (!step.success || !privateStep(step.data)) return entry;
      return Object.fromEntries(
        Object.entries(step.data).map(([key, child]) => [
          key,
          stepSecrets.includes(key) ? "[redacted]" : child,
        ]),
      );
    });
  for (const field of ["action", "interaction"]) {
    const action = record.safeParse(redacted[field]);
    if (action.success)
      redacted[field] = Object.fromEntries(
        Object.entries(action.data).map(([key, child]) => [
          key,
          ["text", "value", "html", "title", "promptText"].includes(key) ? "[redacted]" : child,
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
