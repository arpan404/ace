import { composerView } from "../tui/composer.ts";
import { cutEnd } from "../tui/layout.ts";
import type { Frame } from "../tui/frame.ts";
import type { Paint } from "../tui/paint.ts";
import type { AttachState } from "./attach-model.ts";
import { keysLine } from "./home-view.ts";
import { answerFor, capturing, type OpenRequest } from "./request-answer.ts";
import { requestStrip } from "./request-strip.ts";
import type { LiveLine } from "./transcript.ts";

/**
 * Attach's live region (ADR 0176 §9), below what is already in the scrollback: the turn in
 * progress, the request strip when one is open, the live line, then the composer. Pure.
 */
export interface AttachView {
  /** The unsettled turn's lines (settled ones are already printed). */
  readonly turn: readonly string[];
  readonly request: OpenRequest | undefined;
  /** How many requests are open in this thread, for "1 of 2". */
  readonly requests: number;
  readonly live: LiveLine | undefined;
  /** No thread yet (`ace chat` before its first prompt). */
  readonly fresh: boolean;
  /** A line saying the connection is down or catching up. */
  readonly connection: string | undefined;
  /** The focused "Worked for" line, drawn (`↑` reached it; `↵` unfolds it). */
  readonly focus?: string | undefined;
  /** The transcript has "Worked for" lines `↑` can reach. */
  readonly work?: boolean | undefined;
}

export function attachView(
  state: AttachState,
  view: AttachView,
  width: number,
  height: number,
  paint: Paint,
): Frame {
  const foot: string[] = [];
  let cursor: Frame["cursor"];
  const answer = view.request ? answerFor(state.answer, view.request) : undefined;
  if (view.request && answer) {
    const strip = requestStrip(view.request, answer, width, paint, Math.max(3, height - 8));
    if (strip.cursor) cursor = { row: foot.length + strip.cursor.row, column: strip.cursor.column };
    foot.push(...strip.lines);
    if (view.requests > 1)
      foot.push(paint.dim(`  1 of ${view.requests} · r on the home walks them all`));
  }
  if (view.connection) foot.push(paint.dim(cutEnd(view.connection, width)));
  else if (view.live) foot.push(paint.tone(view.live.tone, cutEnd(`◌ ${view.live.text}`, width)));
  if (state.notice) foot.push(paint.dim(cutEnd(state.notice, width)));
  if (view.focus) {
    foot.push(`› ${view.focus}`);
    foot.push(paint.dim(keysLine(["↵ unfold its steps", "↑↓ other work", "esc back"], width)));
  }
  const typing = answer !== undefined && capturing(answer);
  if (!typing) {
    const placeholder = view.fresh
      ? "What should the agent do?"
      : view.request
        ? "y n a answer · or type a message"
        : "";
    const composer = composerView(state.composer, width, placeholder ? paint.dim(placeholder) : "");
    cursor = { row: foot.length + composer.cursor.row, column: composer.cursor.column };
    foot.push(...composer.lines);
    const keys = ["esc home", "/steer", "/stop", "/model", "/resume", "/quit"];
    if (view.work && !view.focus && !state.composer.text) keys.splice(1, 0, "↑ work");
    foot.push(paint.dim(keysLine(keys, width)));
  }
  const room = Math.max(0, height - foot.length);
  const turn = view.turn.slice(Math.max(0, view.turn.length - room));
  const lines = [...turn, ...foot];
  return { lines, cursor: cursor && { row: cursor.row + turn.length, column: cursor.column } };
}
