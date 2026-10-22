import type { Item } from "@ace/protocol";
import type { ToolMark } from "./ace-tools.ts";
import { exploreAction } from "./explore-command.ts";
import type { DiffStat } from "./file-changes.ts";
import { displayCommand } from "./step-display.ts";
import { isToolSearch, toolSearchRow } from "./tool-search.ts";
import type { StepText } from "./work-log.ts";

/*
 * How a described step reads on its row, on every client: a stat counted off the main thread
 * replaces the described one; a command's exit code is no note of its own (a failed command
 * reads "Failed", a finished one nothing); and a step that waits on the person shows no words of
 * its own, since its request is the composer's. Pure.
 */

export interface ShownStep {
  step: StepText;
  /** The step waits on an approval nobody has answered yet. */
  awaiting: boolean;
}

export function shownStep(item: Item, described: StepText, counted?: DiffStat): ShownStep {
  // Without its interaction loaded, the provider's own status says whether it waits.
  const awaiting =
    described.needsYou ?? (item.type === "tool_call" && item.call.status === "awaiting_approval");
  const withStat = counted ? { ...described, ...counted } : described;
  const step = withStat.note?.startsWith("exit ")
    ? { ...withStat, note: withStat.failed ? "Failed" : undefined }
    : withStat;
  return {
    step: awaiting ? { ...step, verb: "", target: undefined, note: undefined } : step,
    awaiting,
  };
}

/** Whether a step's row opens to more: its output, diff, reasoning or failure. */
export function stepOpens(item: Item): boolean {
  if (item.type !== "tool_call") return item.type === "reasoning" || item.type === "notice";
  const detail = item.call.detail;
  if (item.call.error) return true;
  if (detail.kind === "shell") return !!detail.output;
  if (detail.kind === "search") return false;
  if (detail.kind === "web.search" || detail.kind === "web.fetch" || detail.kind === "file.read")
    return false;
  return true;
}

/** What a step's glyph shows, on every client; each draws its own icon for it. */
export type StepGlyphKind =
  | "device"
  | "computer"
  | "browser"
  | "ace"
  | "think"
  | "note"
  | "read"
  | "search"
  | "list"
  | "command"
  | "edit"
  | "web"
  | "plan"
  | "question"
  | "agent"
  | "image"
  | "tool"
  | "other";

const markGlyphs: Record<Extract<ToolMark, { kind: "glyph" }>["glyph"], StepGlyphKind> = {
  screen: "computer",
  browser: "browser",
  agent: "ace",
  thread: "ace",
  pr: "ace",
  ace: "ace",
};

/**
 * The glyph for what a step did. ace's own tools that act on ace itself show the ace mark; a
 * site or app whose own icon can't be had shows the browser-use or computer-use glyph.
 */
export function stepGlyphKind(item: Item | undefined, mark?: ToolMark): StepGlyphKind {
  if (mark?.kind === "device") return "device";
  if (mark?.kind === "glyph") return markGlyphs[mark.glyph];
  if (mark?.kind === "site") return "browser";
  if (mark?.kind === "app") return "computer";
  if (item?.type === "reasoning") return "think";
  if (item?.type === "notice") return "note";
  if (item?.type !== "tool_call") return "other";
  const detail = item.call.detail;
  switch (detail.kind) {
    case "file.read":
      return "read";
    case "search":
      // Loading the agent's own tools by name is a tool step; a keyword search of them still looks.
      return isToolSearch(item.call) && toolSearchRow(detail.query).loaded ? "tool" : "search";
    case "shell": {
      const explored = exploreAction(displayCommand(detail).command);
      return explored === "search" || explored === "list" || explored === "read"
        ? explored
        : "command";
    }
    case "file.edit":
    case "file.write":
    case "file.delete":
    case "file.move":
    case "notebook":
      return "edit";
    case "web.search":
    case "web.fetch":
      return "web";
    case "browser":
      return "browser";
    case "todo":
    case "plan":
      return "plan";
    case "ask_user":
      return "question";
    case "agent.spawn":
    case "agent.message":
      return "agent";
    case "image":
      return "image";
    case "mcp":
      return "tool";
    default:
      return "other";
  }
}
