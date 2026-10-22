/*
 * The model-facing text for an app observation: one indented line per element, keyed by a
 * stable id, and a diff against the caller's previous look so repeated observations cost
 * only what changed. Pure: no I/O, no clocks.
 */
import type { ComputerNode, ComputerState } from "./wire.ts";

export interface OutlineLine {
  id: number;
  depth: number;
  text: string;
}

/** What one caller last saw of one app: the window it looked at and every line. */
export interface OutlineBaseline {
  windowKey: string;
  lines: ReadonlyMap<number, string>;
}

const escape = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");

export function nodeLine(node: ComputerNode): string {
  let line = `${node.id} ${node.role}`;
  if (node.flags?.length) line += ` (${node.flags.join(", ")})`;
  if (node.name) line += ` ${escape(node.name)}`;
  const extras: string[] = [];
  if (node.value !== undefined) extras.push(`Value: ${escape(node.value)}`);
  if (node.detail) extras.push(`Description: ${escape(node.detail)}`);
  if (node.placeholder) extras.push(`Placeholder: ${escape(node.placeholder)}`);
  if (node.url) extras.push(`URL: ${node.url}`);
  if (node.actions?.length) extras.push(`Actions: ${node.actions.join(", ")}`);
  return extras.length ? `${line}, ${extras.join(", ")}` : line;
}

export function outlineLines(nodes: readonly ComputerNode[]): OutlineLine[] {
  return nodes.map((node) => ({ id: node.id, depth: node.depth, text: nodeLine(node) }));
}

const indent = (line: OutlineLine) => "\t".repeat(line.depth) + line.text;

/** Collapses sorted ids into ranges: [3,4,5,9] → "3-5, 9". */
export function idRanges(ids: readonly number[]): string {
  const sorted = ids.toSorted((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length;) {
    const start = sorted[index] ?? 0;
    let end = start;
    while (sorted[index + 1] === end + 1) end = sorted[++index] ?? end;
    parts.push(start === end ? `${start}` : `${start}-${end}`);
    index++;
  }
  return parts.join(", ");
}

export type OutlineBody =
  | { kind: "full"; text: string }
  | { kind: "diff"; text: string }
  | { kind: "unchanged"; text: string };

/**
 * The full outline, or only what changed since `previous`. Changed lines carry `~`, new ones
 * `+`; unchanged ancestors of a change are printed bare so the change has its context.
 * Large changes fall back to the full outline, which is easier to read than a long diff.
 */
export function outlineBody(
  lines: readonly OutlineLine[],
  observedWindow: string,
  previous: OutlineBaseline | undefined,
): OutlineBody {
  const full = { kind: "full" as const, text: lines.map(indent).join("\n") };
  if (!previous || previous.windowKey !== observedWindow) return full;
  const marks = new Map<number, "+" | "~">();
  for (const line of lines) {
    const before = previous.lines.get(line.id);
    if (before === undefined) marks.set(line.id, "+");
    else if (before !== line.text) marks.set(line.id, "~");
  }
  const present = new Set(lines.map((line) => line.id));
  const removed = [...previous.lines.keys()].filter((id) => !present.has(id));
  if (marks.size === 0 && removed.length === 0)
    return { kind: "unchanged", text: "No change since your last look." };
  if (marks.size > 40 || marks.size > lines.length * 0.5) return full;

  // Each changed line pulls in its ancestors: the nearest shallower line above it, repeatedly.
  const shown = new Set<number>();
  const stack: OutlineLine[] = [];
  for (const line of lines) {
    while (stack.length && (stack.at(-1)?.depth ?? 0) >= line.depth) stack.pop();
    if (marks.has(line.id)) {
      shown.add(line.id);
      for (const ancestor of stack) shown.add(ancestor.id);
    }
    stack.push(line);
  }
  const body = lines
    .filter((line) => shown.has(line.id))
    .map((line) => `${marks.get(line.id) ?? " "}${indent(line)}`);
  if (removed.length) body.push(`Removed: ${idRanges(removed)}`);
  return {
    kind: "diff",
    text: `Changes since your last look (+ new, ~ changed, unmarked lines are context):\n${body.join("\n")}`,
  };
}

export function baselineOf(lines: readonly OutlineLine[], observedWindow: string): OutlineBaseline {
  return { windowKey: observedWindow, lines: new Map(lines.map((line) => [line.id, line.text])) };
}

/** Identifies the observed window: its root element id and title. */
export function windowKey(state: ComputerState): string {
  const root = state.nodes[0];
  return `${state.app.pid}:${root?.depth === 0 ? root.id : "none"}`;
}

const where = (onScreen: boolean | undefined) =>
  onScreen ? "on screen" : "off screen: another Space, hidden or covered by a full-screen app";

export function stateHeader(state: ComputerState): string {
  const { app, window, windows } = state;
  const lines = [
    `${app.name} (${app.bundleId})${app.active ? ", frontmost" : ", in the background"}${state.launched ? ", just opened" : ""}`,
  ];
  if (state.screenLocked)
    lines.push(
      "The Mac is locked. Use accessibility actions and element ids; screenshots and activate are unavailable.",
    );
  if (!window) {
    lines.push(
      windows.length
        ? "No window selected."
        : `No open windows. Open one through the menu bar, e.g. menu ["File", "New"].`,
    );
  } else {
    lines.push(
      `Window: "${window.title}" ${window.width}×${window.height}, ${where(window.onScreen)}`,
    );
  }
  if (state.notResponding) lines.push(`${app.name} is not responding; the outline may be partial.`);
  if (windows.length > 1)
    lines.push(
      `Windows: ${windows.map((entry) => `${entry.index} "${entry.title}"${entry.current ? " (shown)" : ""}${entry.minimized ? " (minimized)" : ""}${entry.otherSpace ? " (another Space)" : ""}`).join(", ")}. Pass window to switch.`,
    );
  return lines.join("\n");
}

/** The screenshot's coordinate space, or why there is none. */
export function screenshotNote(state: ComputerState): string | undefined {
  if (state.screenshot)
    return `Screenshot: ${state.screenshot.width}×${state.screenshot.height} px. Click coordinates are pixels in this image.`;
  return state.screenshotError ? `No screenshot: ${state.screenshotError}` : undefined;
}

export function stateFooter(state: ComputerState, includeMenuBar: boolean): string {
  const lines: string[] = [];
  if (state.truncated)
    lines.push(
      "The outline was cut short (very large window). Scroll or narrow down, or take a screenshot.",
    );
  const focused = state.focused;
  if (focused && (focused.id !== undefined || focused.name))
    lines.push(
      `Focused: ${focused.id !== undefined ? `${focused.id} ` : ""}${focused.role ?? ""}${focused.name ? ` ${focused.name}` : ""}`.trim(),
    );
  if (focused?.selectedText) lines.push(`Selected text: ${escape(focused.selectedText)}`);
  if (includeMenuBar && state.menuBar.length) lines.push(`Menu bar: ${state.menuBar.join(", ")}`);
  const picture = screenshotNote(state);
  if (picture) lines.push(picture);
  if (!state.screenLocked && state.window && !state.window.onScreen && state.nodes.length < 6)
    lines.push(
      "This window shows almost no accessible content while it is off screen. Observe again after it loads, or try a screenshot. Activating it would interrupt the person.",
    );
  return lines.join("\n");
}

/** Lines containing `query` (case-insensitive), each with its ancestors for context. */
export function findLines(lines: readonly OutlineLine[], query: string): string {
  const wanted = query.toLowerCase();
  const shown = new Set<number>();
  const stack: OutlineLine[] = [];
  let matches = 0;
  for (const line of lines) {
    while (stack.length && (stack.at(-1)?.depth ?? 0) >= line.depth) stack.pop();
    if (line.text.toLowerCase().includes(wanted)) {
      matches++;
      shown.add(line.id);
      for (const ancestor of stack) shown.add(ancestor.id);
    }
    stack.push(line);
  }
  if (!matches) return `Nothing in the window matches "${query}".`;
  const body = lines
    .filter((line) => shown.has(line.id))
    .map(indent)
    .join("\n");
  return `${matches} element${matches === 1 ? "" : "s"} match "${query}":\n${body}`;
}
