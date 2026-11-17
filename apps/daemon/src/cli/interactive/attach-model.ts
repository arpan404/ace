import { composerKey, emptyComposer, type Composer } from "../tui/composer.ts";
import { isCtrl, type Key } from "../tui/keys.ts";
import { stay, step, type Step } from "./effects.ts";
import { answerKey, answerStart, capturing, type AnswerState, type OpenRequest } from "./request-answer.ts";

/**
 * Attach's keys (ADR 0176 §9). Pure. Typing goes to the composer (`›`), Enter sends it to the
 * queue and `/steer`, `/stop`, `/model`, `/resume` and `/quit` keep their meaning; while a
 * request is open and the composer is empty, `y`, `n` and `a` answer it; `Esc` goes home.
 */
export interface AttachState {
  readonly composer: Composer;
  readonly answer: AnswerState;
  readonly notice: string | undefined;
}

export const attachStart: AttachState = { composer: emptyComposer, answer: answerStart, notice: undefined };

export function attachKey(
  state: AttachState,
  request: OpenRequest | undefined,
  key: Key,
  pageHeight = 10,
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
  if (key.name === "escape") return step({ ...quiet, answer: answerStart }, { kind: "home" });
  const edit = composerKey(state.composer, key);
  if (edit.kind === "editor") return step({ ...quiet, composer: edit.composer }, { kind: "editor", text: edit.composer.text });
  if (edit.kind === "submit") {
    const text = edit.text;
    if (!text.trim()) return stay({ ...quiet, composer: edit.composer });
    const trimmed = text.trim();
    // `//` sends text that starts with a slash.
    if (trimmed.startsWith("/") && !trimmed.startsWith("//"))
      return step({ ...quiet, composer: edit.composer }, { kind: "slash", line: trimmed });
    return step(
      { ...quiet, composer: edit.composer },
      { kind: "send", text: trimmed.startsWith("//") ? text.replace("//", "/") : text, delivery: "queue" },
    );
  }
  return stay({ ...quiet, composer: edit.composer });
}
