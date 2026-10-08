import type { Item, RawPayload, ToolStatus } from "@ace/protocol";
import { toolProblem, type AceToolFamily, type ToolProblem } from "./ace-tool-problems.ts";
import { aceSpecs, unknownAceTool } from "./ace-tool-specs-ace.ts";
import {
  say,
  siteOf,
  str,
  surfaceSpecs,
  type AceToolSpec,
  type ToolWords,
} from "./ace-tool-specs.ts";
import { appName } from "./app-names.ts";
import { field, mcpFailure, mcpResultParts } from "./mcp-result.ts";

export type { AceToolFamily, ToolProblem } from "./ace-tool-problems.ts";
export type { AceToolSpec, ToolWords } from "./ace-tool-specs.ts";

/*
 * ace's own tools (computer use, the browser, devices, agents and threads) as a transcript row:
 * the icon of what it acted on, a plain sentence ("Pressed ⌘L in Safari"), the images it
 * answered with, and a failure in words with a hint. One registry (`ace-tool-specs*.ts`) maps
 * tool names to words; this reads a call and its result against it. Pure.
 */

/** What a row's icon shows: the app's own icon, the site's letter tile, a device or a glyph. */
export type ToolMark =
  | { kind: "app"; bundleId: string; name: string }
  | { kind: "site"; host: string }
  | { kind: "device"; platform: "ios" | "android" | undefined }
  | { kind: "glyph"; glyph: "screen" | "browser" | "agent" | "thread" | "ace" };

/** What earlier steps of the same log tell about this one. All optional. */
export interface AceToolContext {
  /** The app a computer-use step acted on, and the daemon's record of how it went. */
  app?:
    | {
        bundleId: string;
        mode?: "background" | "foreground" | undefined;
        outcome?: string | undefined;
      }
    | undefined;
  /** The site the browser was on. */
  site?: string | undefined;
  /** The device's name, from an earlier list. */
  device?: string | undefined;
  /** The accessible name of the element the step's `ref` points at, from an earlier read. */
  element?: string | undefined;
}

export interface AceToolCall {
  server: string;
  tool: string;
  args?: unknown;
  status: ToolStatus;
  raw: readonly RawPayload[];
  error?: string | undefined;
  /**
   * The MCP result when the daemon types it (`{ isError, content, structuredContent }`); until
   * then results are read from the provider's `raw`.
   */
  result?: unknown;
}

export interface AceToolView {
  family: AceToolFamily;
  mark: ToolMark;
  words: ToolWords;
  /** What consecutive steps group under ("Used Safari"): one app, site, device or family. */
  subject?: { key: string; label: string } | undefined;
  /** Images the tool answered with, as `data:` URLs. */
  images: string[];
  problem?: ToolProblem | undefined;
  /** "ace · screen_key", for Details. */
  tool: string;
}

const aceServer = /^ace$|^ace[-_]/;
const measurementTools = new Set(["screen_measure_interaction", "ace_browser_measure_interaction"]);
const glyphs: Record<"agents" | "threads" | "ace", ToolMark> = {
  agents: { kind: "glyph", glyph: "agent" },
  threads: { kind: "glyph", glyph: "thread" },
  ace: { kind: "glyph", glyph: "ace" },
};
const groupLabels: Partial<Record<AceToolFamily, string>> = {
  agents: "Worked with agents",
  threads: "Worked with threads",
};

/** The spec for one of ace's tools, or undefined for anyone else's. */
export function aceToolSpec(server: string, tool: string): AceToolSpec | undefined {
  const name = aceToolName(tool);
  const ours = aceServer.test(server) || /^(ace_|screen_)/.test(name);
  if (!ours) return undefined;
  return (
    surfaceSpecs[name] ??
    aceSpecs[name] ??
    (name.startsWith("ace_") ? unknownAceTool(name) : undefined)
  );
}

/**
 * A tool's registry name, whatever the provider prefixed: Claude's `mcp__ace__screen_click`,
 * OpenCode's `ace_screen_click` and `ace_ace_browser_open` all read as ace's own name.
 */
export function aceToolName(tool: string): string {
  const name = tool.replace(/^mcp__ace__/, "");
  if (surfaceSpecs[name] || aceSpecs[name]) return name;
  const unprefixed = name.replace(/^ace_/, "");
  return surfaceSpecs[unprefixed] || aceSpecs[unprefixed] ? unprefixed : name;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** "ios:…" ids are simulators; "android:…" emulators or phones. */
function platformOf(deviceId: string | undefined): "ios" | "android" | undefined {
  if (deviceId?.startsWith("ios:")) return "ios";
  if (deviceId?.startsWith("android:")) return "android";
  return undefined;
}

interface Subject {
  /** As sentences name it, when known. */
  name: string | undefined;
  mark: ToolMark;
  group?: { key: string; label: string } | undefined;
}

function subjectOf(
  spec: AceToolSpec,
  args: Record<string, unknown>,
  context: AceToolContext,
): Subject {
  switch (spec.family) {
    case "screen": {
      const bundleId = context.app?.bundleId ?? str(args, "bundleId");
      if (!bundleId) return { name: undefined, mark: { kind: "glyph", glyph: "screen" } };
      const name = appName(bundleId);
      return {
        name,
        mark: { kind: "app", bundleId, name },
        group: { key: `app:${bundleId.toLowerCase()}`, label: `Used ${name}` },
      };
    }
    case "browser": {
      const host = siteOf(str(args, "url")) ?? context.site;
      return host
        ? {
            name: host,
            mark: { kind: "site", host },
            group: { key: `site:${host}`, label: `Browsed ${host}` },
          }
        : {
            name: undefined,
            mark: { kind: "glyph", glyph: "browser" },
            group: { key: "browser", label: "Used the browser" },
          };
    }
    case "device": {
      const deviceId = str(args, "deviceId");
      const platform = platformOf(deviceId);
      const fallback =
        platform === "ios"
          ? "the simulator"
          : platform === "android"
            ? "the Android device"
            : undefined;
      const name = context.device ?? fallback;
      const label = context.device ?? fallback ?? "devices";
      return {
        name,
        mark: { kind: "device", platform },
        group: { key: `device:${deviceId ?? ""}`, label: `Used ${label}` },
      };
    }
    default: {
      const label = groupLabels[spec.family];
      return {
        name: undefined,
        mark: glyphs[spec.family],
        group: label ? { key: spec.family, label } : undefined,
      };
    }
  }
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** One of ace's own steps as its row reads it; undefined for any other server's tool. */
export function aceToolView(
  call: AceToolCall,
  context: AceToolContext = {},
): AceToolView | undefined {
  const spec = aceToolSpec(call.server, call.tool);
  return spec && viewOf(spec, call, context);
}

function viewOf(spec: AceToolSpec, call: AceToolCall, context: AceToolContext): AceToolView {
  const args = record(call.args);
  const subject = subjectOf(spec, args, context);
  const words = spec.words({ args, subject: subject.name, element: context.element });
  const raw: readonly RawPayload[] =
    call.result === undefined ? call.raw : [{ type: "result", data: call.result }, ...call.raw];
  const parts =
    raw.length && !measurementTools.has(aceToolName(call.tool)) ? mcpResultParts(raw) : undefined;
  // Some adapters report an MCP error result as a success; the typed result says otherwise.
  const failed = call.status === "failed" || field(call.result, "isError") === true;
  let problem: ToolProblem | undefined;
  if (failed) {
    const failure = mcpFailure(parts?.texts ?? [], call.error);
    const audited = context.app?.outcome;
    const code =
      (audited && audited !== "completed" && audited !== "failed" ? audited : undefined) ??
      failure?.code ??
      "failed";
    problem = toolProblem({
      family: spec.family,
      code,
      subject: subject.name,
      input: spec.input,
      mode: context.app?.mode,
      attempt: lowerFirst(words.target ? `${words.awaiting} ${words.target}` : words.awaiting),
      message:
        failure?.code === code
          ? failure.message
          : code === "failed"
            ? call.error
                ?.split("\n")
                .find((line) => line.trim())
                ?.trim()
            : undefined,
    });
  }
  return {
    family: spec.family,
    mark: subject.mark,
    words,
    subject: subject.group,
    images: parts?.images ?? [],
    problem,
    tool: `${call.server} · ${call.tool}`,
  };
}

/** The sentence an ace tool reads with, without its result or log; undefined for others. */
export function aceToolWords(server: string, tool: string, args?: unknown): ToolWords | undefined {
  const spec = aceToolSpec(server, tool);
  if (!spec) return undefined;
  const facts = record(args);
  return spec.words({ args: facts, subject: subjectOf(spec, facts, {}).name, element: undefined });
}

/* ---------------------------------------------------------------------------------------- */
/* The daemon's own record of a computer-use action                                         */

/** A `screen.step` notice: the daemon's audit of one agent action on an app. */
export interface ScreenStep {
  action: string;
  /** Undefined when the agent acted on a whole display. */
  bundleId: string | undefined;
  mode: "background" | "foreground" | undefined;
  /** "completed", or the helper's failure code ("not_supported", "focus_changed", …). */
  outcome: string;
  /** The tool call it audits, once the daemon links them. */
  toolCallId?: string | undefined;
}

/**
 * The daemon writes `action · bundle id · mode · outcome` with `{ action, mode, outcome }` as
 * raw data. Newer daemons add `bundleId` and `toolCallId` to the data; older ones name the app
 * only in the text, so that is the fallback.
 */
export function screenStep(item: Item | undefined): ScreenStep | undefined {
  if (item?.type !== "notice" || item.code !== "screen.step") return undefined;
  const [action, target, mode, outcome] = item.text.split(" · ");
  const data = item.raw.find((raw) => raw.type === "ace.screen.step");
  const fromRaw = (key: string) => {
    const value = data && "data" in data ? field(data.data, key) : undefined;
    return typeof value === "string" ? value : undefined;
  };
  const shownAction = fromRaw("action") ?? action;
  const shownOutcome = fromRaw("outcome") ?? outcome;
  if (!shownAction || !shownOutcome) return undefined;
  const shownMode = fromRaw("mode") ?? mode;
  const bundleId = fromRaw("bundleId") ?? (target && target !== "display" ? target : undefined);
  return {
    action: shownAction,
    bundleId,
    mode: shownMode === "background" || shownMode === "foreground" ? shownMode : undefined,
    outcome: shownOutcome,
    toolCallId: fromRaw("toolCallId") ?? item.toolCallId,
  };
}

const uiActions = new Set([
  "press",
  "focus",
  "setValue",
  "expand",
  "select",
  "performSecondaryAction",
  "selectText",
]);
const actionTools: Record<string, string> = {
  "key.press": "screen_key",
  key: "screen_key",
  "text.type": "screen_type",
  type: "screen_type",
  "text.paste": "screen_paste",
  "pointer.click": "screen_click",
  "pointer.drag": "screen_click",
  click: "screen_click",
  scroll: "screen_scroll",
  measure_interaction: "screen_measure_interaction",
};

/** The computer-use tools whose call an audited action belongs to. */
export function screenStepTools(action: string): readonly string[] {
  if (action === "scroll") return ["screen_scroll", "screen_ui_act"];
  if (uiActions.has(action)) return ["screen_ui_act"];
  const tool = actionTools[action];
  return tool ? [tool] : [];
}

/** An audited action no call shows, as its own row: "Pressed a key in Safari". */
export function screenStepView(step: ScreenStep): AceToolView {
  const [tool] = screenStepTools(step.action);
  const context: AceToolContext = step.bundleId
    ? { app: { bundleId: step.bundleId, mode: step.mode, outcome: step.outcome } }
    : {};
  const status = step.outcome === "completed" ? "succeeded" : "failed";
  const args = uiActions.has(step.action) ? { action: step.action } : {};
  const call = { server: "ace", tool: tool ?? "screen", args, status, raw: [] } as const;
  return viewOf((tool && surfaceSpecs[tool]) || usedApp, call, context);
}

/** An audited action ace has no words for. */
const usedApp: AceToolSpec = {
  family: "screen",
  words: ({ subject }) => say(["Used", "Using", "Use"], ` ${subject ?? "the screen"}`),
};

/* ---------------------------------------------------------------------------------------- */
/* From a transcript item                                                                    */

/** The first object under `arguments`, `input` or `args` in a provider's payloads. */
function argsFromRaw(raw: readonly RawPayload[]): unknown {
  let found: unknown;
  const visit = (value: unknown, depth: number): void => {
    if (found !== undefined || depth > 4 || typeof value !== "object" || value === null) return;
    for (const key of ["arguments", "input", "args"]) {
      const entry = field(value, key);
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        found = entry;
        return;
      }
    }
    for (const entry of Object.values(value)) visit(entry, depth + 1);
  };
  for (const payload of raw) if ("data" in payload) visit(payload.data, 0);
  return found;
}

/**
 * An item as one of ace's tool calls: an MCP call to ace, or a provider's `custom` call named
 * for an ace tool (OpenCode and Pi report some that way, with their arguments only in `raw`).
 */
export function aceCallOf(item: Item | undefined): AceToolCall | undefined {
  if (item?.type !== "tool_call") return undefined;
  const { call } = item;
  const result: unknown = Reflect.get(call, "result");
  const shared = { status: call.status, raw: call.raw, error: call.error, result };
  if (call.detail.kind === "mcp") {
    if (!aceToolSpec(call.detail.server, call.detail.tool)) return undefined;
    return {
      server: call.detail.server,
      tool: aceToolName(call.detail.tool),
      args: call.detail.arguments,
      ...shared,
    };
  }
  if (call.detail.kind !== "custom") return undefined;
  const tool = aceToolName(call.title.trim());
  if (!surfaceSpecs[tool] && !aceSpecs[tool]) return undefined;
  return { server: "ace", tool, args: argsFromRaw(call.raw), ...shared };
}
