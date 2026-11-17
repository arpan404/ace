import { composerKey, emptyComposer, type Composer } from "../tui/composer.ts";
import { isCtrl, type Key } from "../tui/keys.ts";
import { stay, step, type Step } from "./effects.ts";
import {
  answerKey,
  answerStart,
  capturing,
  type AnswerState,
  type OpenRequest,
} from "./request-answer.ts";

/**
 * Attach's keys (ADR 0178 §9). Pure. Typing goes to the composer (`›`), Enter sends it to the
 * queue and `/steer`, `/stop`, `/model`, `/resume` and `/quit` keep their meaning; while a
 * request is open and the composer is empty, `y`, `n` and `a` answer it; `Esc` goes home.
 * With the composer empty, `↑` and `↓` walk the thread's "Worked for" lines and `↵` on one
 * unfolds its steps, as the app does.
 */
export interface AttachState {
  readonly composer: Composer;
  readonly answer: AnswerState;
  readonly notice: string | undefined;
  /** The "Worked for" line `↑` reached (its block's key), which `↵` unfolds. */
  readonly focus: string | undefined;
}

export const attachStart: AttachState = {
  composer: emptyComposer,
  answer: answerStart,
  notice: undefined,
  focus: undefined,
};

/** `↑`/`↓` over the work lines (`works`, oldest first); past the newest leaves them. */
function walk(focus: string | undefined, works: readonly string[], up: boolean) {
  const at = focus === undefined ? works.length : works.indexOf(focus);
  const next = at + (up ? -1 : 1);
  if (next >= works.length) return undefined;
  return works[Math.max(0, next)];
}

export function attachKey(
  state: AttachState,
  request: OpenRequest | undefined,
  key: Key,
  pageHeight = 10,
  /** The keys of the transcript's foldable work blocks, oldest first. */
  works: readonly string[] = [],
): Step<AttachState> {
  const quiet = { ...state, notice: undefined };
  if (isCtrl(key, "c")) {
    if (state.composer.text) return stay({ ...quiet, composer: emptyComposer });
    return step(quiet, { kind: "quit", farewell: "", code: 130 });
  }
  if (request && (state.composer.text === "" || capturing(state.answer))) {
    const answered = answerKey(state.answer, request, key, pageHeight);
    if (answered.handled) return step({ ...quiet, answer: answered.state }, ...answered.effects);
  }
  const focus = state.focus !== undefined && works.includes(state.focus) ? state.focus : undefined;
  if (state.composer.text === "" && works.length) {
    if (key.name === "up" || (key.name === "down" && focus !== undefined))
      return stay({ ...quiet, focus: walk(focus, works, key.name === "up") });
    if (focus !== undefined && key.name === "enter")
      return step({ ...quiet, focus }, { kind: "unfold", key: focus });
    if (focus !== undefined && key.name === "escape") return stay({ ...quiet, focus: undefined });
  }
  if (key.name === "escape")
    return step({ ...quiet, answer: answerStart, focus: undefined }, { kind: "home" });
  // Typing leaves the work lines.
  const typing = { ...quiet, focus: undefined };
  const edit = composerKey(state.composer, key);
  if (edit.kind === "editor")
    return step(
      { ...typing, composer: edit.composer },
      { kind: "editor", text: edit.composer.text },
    );
  if (edit.kind === "submit") {
    const text = edit.text;
    if (!text.trim()) return stay({ ...typing, composer: edit.composer });
    const trimmed = text.trim();
    // `//` sends text that starts with a slash.
    if (trimmed.startsWith("/") && !trimmed.startsWith("//"))
      return step({ ...typing, composer: edit.composer }, { kind: "slash", line: trimmed });
    return step(
      { ...typing, composer: edit.composer },
      {
        kind: "send",
        text: trimmed.startsWith("//") ? text.replace("//", "/") : text,
        delivery: "queue",
      },
    );
  }
  return stay({ ...typing, composer: edit.composer });
}
