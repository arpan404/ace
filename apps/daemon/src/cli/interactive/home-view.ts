import { cutEnd, cutMiddle, fit, padStart, textWidth } from "../tui/layout.ts";
import type { Paint } from "../tui/paint.ts";
import { filtered, selectedRow, type HomeState } from "./home-model.ts";
import type { HomeRow } from "./home-rows.ts";
import type { TreeLine } from "./tree.ts";

/**
 * The home drawn at a width (ADR 0176 §9): one flat list, then one line of keys. Pure. Below
 * 60 columns the meta columns (branch, provider, project) drop.
 */
export interface HomeView {
  readonly rows: readonly HomeRow[];
  /** The list hasn't arrived yet (no cached copy either). */
  readonly loading: boolean;
  /** Open requests across threads, for the keys line. */
  readonly requests: number;
  /** The open row's agents, once its thread has loaded. */
  readonly tree: { readonly lines: readonly TreeLine[]; readonly more: number } | undefined;
  /** A line saying the connection is down or catching up; undefined while live. */
  readonly connection: string | undefined;
}

export const narrow = 60;

/**
 * Keys joined with ` · `, dropping the ones just before the last (quit stays) until the line
 * fits; a single key that still doesn't fit is cut.
 */
export function keysLine(keys: readonly string[], width: number): string {
  const kept = [...keys];
  while (kept.length > 2 && textWidth(kept.join(" · ")) > width) kept.splice(-2, 1);
  return cutEnd(kept.join(" · "), width);
}

const homeKeys = (requests: number) => [
  "n new thread",
  requests ? `r requests ${requests}` : "r requests",
  "p projects",
  "s Spade",
  "m market",
  ", settings",
  "d doctor",
  "? help",
  "q quit",
];

const rowKeys = ["↵ attach", "← fold", "x stop", "z snooze", "e settle", "/ filter"];

const helpLines = [
  "↑↓ or j k move · ↵ attach · → its agents · ← fold",
  "/ filter by words · x stop (asks first) · z snooze · e settle",
  "n new thread · r requests · p projects · s Spade · m market",
  ", settings · d doctor · q quit · any key closes this",
];

function summary(rows: readonly HomeRow[]): string {
  const needs = rows.filter((row) => row.needsYou).length;
  const running = rows.filter((row) => row.state === "working" || row.state === "waiting").length;
  const parts: string[] = [];
  if (needs) parts.push(`${needs} need${needs === 1 ? "s" : ""} you`);
  if (running) parts.push(`${running} running`);
  return parts.join(" · ");
}

function rowLine(row: HomeRow, width: number, paint: Paint, selected: boolean): string {
  const wide = width >= narrow;
  const marker = selected ? "›" : " ";
  const glyph = paint.tone(row.tone, fit(row.glyph, 3));
  const time = fit(row.time, 8);
  if (!wide) {
    const title = fit(row.title, Math.max(4, width - 2 - 3 - 1 - 8));
    return `${marker} ${glyph}${selected ? paint.bold(title) : title} ${paint.dim(time)}`;
  }
  const project = fit(row.project, 10);
  const provider = fit(row.provider, 8);
  const branchWidth = Math.min(24, Math.max(10, Math.floor(width * 0.2)));
  const branch = fit(cutMiddle(row.branch, branchWidth), branchWidth);
  const fixed = 2 + 3 + 10 + 1 + 1 + 8 + 1 + branchWidth + 1 + 8;
  const title = fit(row.title, Math.max(8, width - fixed));
  const line = `${marker} ${glyph}${paint.dim(project)} ${selected ? paint.bold(title) : title} ${paint.dim(time)} ${paint.dim(branch)} ${paint.dim(provider)}`;
  return line.trimEnd();
}

function treeLines(view: HomeView, width: number, paint: Paint): string[] {
  if (!view.tree) return [`      │ ${paint.dim("Reading its agents…")}`];
  if (!view.tree.lines.length) return [`      │ ${paint.dim("No agents yet.")}`];
  const lines = view.tree.lines.map((line) => {
    const indent = "  ".repeat(line.depth);
    const lead = `      │ ${indent}`;
    const name = fit(line.name, 18);
    const time = padStart(line.time, 8);
    const room = Math.max(0, width - textWidth(lead) - 2 - 18 - 1 - 8 - 1);
    const doing = fit(cutEnd(line.doing, room), room);
    return `${lead}${paint.tone(line.tone, line.glyph)} ${name} ${paint.dim(doing)} ${paint.dim(time)}`;
  });
  if (view.tree.more) lines.push(`      │ ${paint.dim(`${view.tree.more} more`)}`);
  return lines;
}

/** The home's lines for a terminal `width` wide and `height` tall. */
export function homeView(
  state: HomeState,
  view: HomeView,
  width: number,
  height: number,
  paint: Paint,
): string[] {
  const head = view.connection ?? summary(view.rows);
  const header = [`ace${head ? `  ${paint.dim(head)}` : ""}`];
  const foot: string[] = [];
  if (state.notice) foot.push(paint.dim(cutEnd(state.notice, width)));
  const visible = filtered(view.rows, state.filter.text);
  const current = selectedRow(state, view.rows);
  if (state.confirmStop) {
    const title = view.rows.find((row) => row.id === state.confirmStop)?.title ?? "this thread";
    foot.push(
      cutEnd(
        `Stop ${title} and every agent under it? y Stop · any other key keeps it running`,
        width,
      ),
    );
  } else if (state.filter.editing)
    foot.push(cutEnd(`/ ${state.filter.text}▏  ↵ keep · esc clear`, width));
  else if (state.help) foot.push(...helpLines.map((line) => cutEnd(line, width)));
  else {
    if (state.filter.text)
      foot.push(paint.dim(cutEnd(`Filtered by “${state.filter.text}” · esc clears`, width)));
    foot.push(keysLine(state.open ? rowKeys : homeKeys(view.requests), width));
  }
  const body: string[] = [];
  if (view.loading && !view.rows.length) body.push(paint.dim("Reading your threads…"));
  else if (!view.rows.length) body.push("No threads yet. n starts one.");
  else if (!visible.length) body.push(paint.dim("No thread matches."));
  const room = Math.max(1, height - header.length - foot.length);
  if (visible.length) {
    const rendered: { id: string; lines: string[] }[] = visible.map((row) => ({
      id: row.id,
      lines: [
        rowLine(row, width, paint, row.id === current?.id),
        ...(row.id === state.open ? treeLines(view, width, paint) : []),
      ],
    }));
    // Keep the selected row (and its open tree) in view.
    const selectedAt = rendered.findIndex((row) => row.id === current?.id);
    const flat = rendered.flatMap((row) => row.lines);
    const start = rendered
      .slice(0, Math.max(0, selectedAt))
      .reduce((sum, row) => sum + row.lines.length, 0);
    const selectedHeight = rendered[selectedAt]?.lines.length ?? 1;
    const first = Math.max(0, Math.min(start, start + selectedHeight - room));
    body.push(...flat.slice(first, first + room));
  }
  return [...header, ...body.slice(0, room), ...foot];
}
