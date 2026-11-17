import type { ThreadRow } from "../work/rows.ts";
import { shortIds } from "../work/refs.ts";
import { statusCell } from "./thread-glyph.ts";

export interface ThreadListView {
  readonly rows: readonly ThreadRow[];
  readonly next: string | null;
  readonly settled: number;
  readonly snoozed: number;
  /** The command as typed, for the next page's hint. */
  readonly command: string;
}

export interface LineOptions {
  readonly now: number;
  readonly colour: boolean;
  /** The terminal's width; titles are cut to fit. Off a terminal nothing is cut. */
  readonly width?: number | undefined;
}

/** Cut in the middle so both ends stay readable: "work/re…treams". */
export function cutMiddle(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max < 2) return chars.slice(0, max).join("");
  const tail = Math.floor((max - 1) / 2);
  return `${chars.slice(0, max - 1 - tail).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

function cutEnd(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

function pad(text: string, width: number, shown = Array.from(text).length): string {
  return text + " ".repeat(Math.max(0, width - shown));
}

/**
 * One row per thread in the app's order: status, id, project, title, branch, provider. No
 * section labels; ids are plain so they can be copied back. Pure.
 */
export function threadListLines(view: ThreadListView, options: LineOptions): string[] {
  if (!view.rows.length) return [emptyLine(view), ...hiddenLines(view)];
  const ids = shortIds(view.rows.map((row) => row.threadId));
  const cells = view.rows.map((row) => statusCell(row, options.now, options.colour));
  const statusWidth = Math.max(...cells.map((cell) => cell.width));
  const idWidth = Math.max(...view.rows.map((row) => (ids.get(row.threadId) ?? "").length));
  const narrow = options.width !== undefined && options.width < 60;
  const projectWidth = Math.min(16, Math.max(...view.rows.map((row) => row.project.length)));
  const fixed = statusWidth + idWidth + (narrow ? 0 : projectWidth + 2) + 4;
  const room = options.width === undefined ? undefined : Math.max(12, options.width - fixed);
  const lines = view.rows.map((row, index) => {
    const cell = cells[index] ?? { text: "", width: 0 };
    const id = ids.get(row.threadId) ?? row.threadId;
    const meta = narrow ? [] : [row.branch, row.provider].filter(Boolean);
    const tail = meta.length ? `  ${meta.join("  ")}` : "";
    let title = row.title;
    let shownTail = tail;
    if (room !== undefined) {
      const left = room - Array.from(tail).length;
      if (left >= 12) title = cutEnd(title, left);
      else {
        shownTail = "";
        title = cutEnd(title, room);
      }
    }
    const parts = [
      pad(cell.text, statusWidth, cell.width),
      pad(id, idWidth),
      ...(narrow ? [] : [pad(cutMiddle(row.project, projectWidth), projectWidth)]),
      `${title}${shownTail}`,
    ];
    return parts.join("  ").trimEnd();
  });
  return [...lines, ...hiddenLines(view)];
}

function emptyLine(view: ThreadListView): string {
  return view.settled || view.snoozed ? "Nothing in the list." : "No threads yet.";
}

function hiddenLines(view: ThreadListView): string[] {
  const lines: string[] = [];
  if (view.next) lines.push(`More: ${view.command} --after ${view.next}`);
  const hidden = [
    view.settled ? `${view.settled} settled` : "",
    view.snoozed ? `${view.snoozed} snoozed` : "",
  ].filter(Boolean);
  if (hidden.length && !view.next)
    lines.push(`Not shown: ${hidden.join(", ")}. See settled ones with ace thread list --settled.`);
  return lines;
}
