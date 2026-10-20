import type { Item, RawPayload, ToolStatus } from "@ace/protocol";
import { bareToolName } from "@ace/provider-kit/ace-tool-names";
import { toolProblem, type AceToolFamily, type ToolProblem } from "./ace-tool-problems.ts";
import { aceSpecs, unknownAceTool } from "./ace-tool-specs-ace.ts";
import { computerSpecs } from "./ace-tool-specs-computer.ts";
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
  | { kind: "glyph"; glyph: "screen" | "browser" | "agent" | "thread" | "pr" | "ace" };

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
  /** "ace · screen_input", for Details. */
  tool: string;
}

const aceServer = /^ace$|^ace[-_]/;
/** Computer use, the browser and devices, by tool name. */
const surfaces: Readonly<Record<string, AceToolSpec>> = { ...surfaceSpecs, ...computerSpecs };
const measurementTools = new Set(["screen_measure", "browser_measure"]);
const glyphs: Record<"agents" | "threads" | "ace", ToolMark> = {
  agents: { kind: "glyph", glyph: "agent" },
  threads: { kind: "glyph", glyph: "thread" },
  ace: { kind: "glyph", glyph: "ace" },
};
const groupLabels: Partial<Record<AceToolFamily, string>> = {
  agents: "Worked with agents",
  threads: "Worked with threads",
};

/**
 * The spec for one of ace's tools, or undefined for anyone else's. A call is ace's when ace's
 * server made it or its name carries ace's namespace; another server's bare `context` is not.
 */
export function aceToolSpec(server: string, tool: string): AceToolSpec | undefined {
  const ours = aceServer.test(server) || /^(?:mcp__ace__|ace_|screen_)/.test(tool);
  if (!ours) return undefined;
  const name = aceToolName(tool);
  return surfaces[name] ?? aceSpecs[name] ?? unknownAceTool(name);
}

/**
 * A tool's bare name, whatever the provider prefixed: Claude's `mcp__ace__screen_input`,
 * OpenCode's `ace_screen_input` and a toolkit's old `ace_browser_open` all read as ace's own.
 */
export function aceToolName(tool: string): string {
  return bareToolName(tool);
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** "ios:…" ids are simulators; "android:…" emulators or phones. */
function platformOf(simId: string | undefined): "ios" | "android" | undefined {
  if (simId?.startsWith("ios:")) return "ios";
  if (simId?.startsWith("android:")) return "android";
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
      // Older tools name a bundle id; newer ones an app by name or bundle id.
      const bundleId = context.app?.bundleId ?? str(args, "bundleId") ?? str(args, "app");
      if (!bundleId) return { name: undefined, mark: { kind: "glyph", glyph: "screen" } };
      const name = appName(bundleId);
      return {
        name,
        mark: { kind: "app", bundleId, name },
        // By name, so "Calculator" and `com.apple.calculator` are one app.
        group: { key: `app:${name.toLowerCase()}`, label: `Used ${name}` },
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
      const simId = str(args, "simId");
      const platform = platformOf(simId);
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
        group: { key: `device:${simId ?? ""}`, label: `Used ${label}` },
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

/** "Went to github.com on studio": a call made on another paired machine says where. */
function onMachine(words: ToolWords, args: Record<string, unknown>): ToolWords {
  const machine = str(args, "machine");
  if (!machine) return words;
  // A code target follows the words, so the machine leads: "On studio, went to `x.com`".
  const place = (text: string) =>
    words.target ? `On ${machine}, ${lowerFirst(text)}` : `${text} on ${machine}`;
  return {
    ...words,
    past: place(words.past),
    running: place(words.running),
    awaiting: place(words.awaiting),
  };
}

function viewOf(spec: AceToolSpec, call: AceToolCall, context: AceToolContext): AceToolView {
  const args = record(call.args);
  const subject = subjectOf(spec, args, context);
  let words = onMachine(
    spec.words({ args, subject: subject.name, element: context.element }),
    args,
  );
  const raw: readonly RawPayload[] =
    call.result === undefined ? call.raw : [{ type: "result", data: call.result }, ...call.raw];
  const parts =
    raw.length && !measurementTools.has(aceToolName(call.tool)) ? mcpResultParts(raw) : undefined;
  const name = aceToolName(call.tool);
  const isPr = name === "thread_link_pr";
  if (isPr) {
    let data = field(field(call.result, "structuredContent") ?? call.result, "data");
    if (!data)
      for (const text of parts?.texts ?? []) {
        try {
          const parsed: unknown = JSON.parse(text);
          data = field(parsed, "data");
        } catch {
          /* Provider text may be prose. */
        }
        if (data) break;
      }
    const number = field(data, "number");
    if (typeof number === "number")
      words = say(
        args.unlink === true ? ["Unlinked", "Unlinking", "Unlink"] : ["Linked", "Linking", "Link"],
        ` PR #${number}`,
      );
  }
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
      input: typeof spec.input === "function" ? spec.input(args) : spec.input,
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
    mark: isPr ? { kind: "glyph", glyph: "pr" } : subject.mark,
    words,
    subject: isPr ? undefined : subject.group,
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
  return onMachine(
    spec.words({ args: facts, subject: subjectOf(spec, facts, {}).name, element: undefined }),
    facts,
  );
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
/** The `screen_input` action an audited input action came from. */
const inputActions: Record<string, string> = {
  "key.press": "key",
  key: "key",
  "text.type": "type",
  type: "type",
  "text.paste": "paste",
  "pointer.click": "click",
  "pointer.drag": "click",
  click: "click",
  scroll: "scroll",
};

/** The computer-use tools whose call an audited action belongs to. */
export function screenStepTools(action: string): readonly string[] {
  // Newer daemons audit each call under its tool's name.
  if (computerSpecs[action]) return [action];
  if (action === "scroll") return ["screen_input", "screen_ui_act"];
  if (uiActions.has(action)) return ["screen_ui_act"];
  if (action === "measure_interaction") return ["screen_measure"];
  return inputActions[action] ? ["screen_input"] : [];
}

/** An audited action no call shows, as its own row: "Pressed a key in Safari". */
export function screenStepView(step: ScreenStep): AceToolView {
  const [tool] = screenStepTools(step.action);
  const context: AceToolContext = step.bundleId
    ? { app: { bundleId: step.bundleId, mode: step.mode, outcome: step.outcome } }
    : {};
  const status = step.outcome === "completed" ? "succeeded" : "failed";
  const input = inputActions[step.action];
  const args = uiActions.has(step.action)
    ? { action: step.action }
    : input
      ? { action: input }
      : {};
  const call = { server: "ace", tool: tool ?? "screen", args, status, raw: [] } as const;
  return viewOf((tool && surfaces[tool]) || usedApp, call, context);
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
    // A namespaced name reported under another server label is still ace's own tool.
    return {
      server: aceServer.test(call.detail.server) ? call.detail.server : "ace",
      tool: aceToolName(call.detail.tool),
      args: call.detail.arguments,
      ...shared,
    };
  }
  if (call.detail.kind !== "custom") return undefined;
  // A bare custom name is the provider's own unless it is a computer-use or device tool.
  const title = call.title.trim();
  const tool = aceToolName(title);
  if (!/^(?:mcp__ace__|ace_|screen_|device_)/.test(title)) return undefined;
  if (!surfaces[tool] && !aceSpecs[tool]) return undefined;
  return { server: "ace", tool, args: argsFromRaw(call.raw), ...shared };
}
