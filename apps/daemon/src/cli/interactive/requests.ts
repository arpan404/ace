import type { ThreadReader } from "@ace/client";
import type { ProviderKind } from "@ace/protocol";
import { isCtrl, typed, type Key } from "../tui/keys.ts";
import { cutEnd, padEnd, textWidth } from "../tui/layout.ts";
import type { Paint } from "../tui/paint.ts";
import { step, stay, type Step } from "./effects.ts";
import { keysLine } from "./home-view.ts";
import {
  answerFor,
  answerKey,
  answerStart,
  capturing,
  type AnswerState,
  type OpenRequest,
} from "./request-answer.ts";
import { requestStrip, type StripView } from "./request-strip.ts";

/**
 * Requests (`r` on the home, ADR 0176 §9): every open approval, question and plan review
 * across threads, one at a time ("1 of 3"). Pure: the shell gathers the open requests from the
 * client's thread stores (`openRequests`) and carries out the effects.
 */
export interface RequestsState {
  readonly index: number;
  readonly answer: AnswerState;
  /** Answered here: hidden at once, before the daemon's close arrives. */
  readonly answered: readonly string[];
  readonly notice: string | undefined;
}

export const requestsStart: RequestsState = {
  index: 0,
  answer: answerStart,
  answered: [],
  notice: undefined,
};

/** The pending requests in one thread's store, oldest first. */
export function threadRequests(
  reader: ThreadReader,
  facts: { title: string; project: string; provider: ProviderKind },
): OpenRequest[] {
  return reader.interactionIds().flatMap((id) => {
    const interaction = reader.interaction(id);
    if (interaction?.state !== "pending") return [];
    return [
      { interaction, threadTitle: facts.title, project: facts.project, provider: facts.provider },
    ];
  });
}

export function visibleRequests(
  state: RequestsState,
  requests: readonly OpenRequest[],
): OpenRequest[] {
  return requests.filter((request) => !state.answered.includes(request.interaction.id));
}

function current(state: RequestsState, requests: readonly OpenRequest[]) {
  const list = visibleRequests(state, requests);
  const index = Math.max(0, Math.min(state.index, list.length - 1));
  return { list, index, request: list[index] };
}

export function requestsKey(
  state: RequestsState,
  requests: readonly OpenRequest[],
  key: Key,
  pageHeight = 10,
): Step<RequestsState> {
  if (isCtrl(key, "c")) return step(state, { kind: "quit", farewell: "", code: 130 });
  const { list, index, request } = current(state, requests);
  if (request) {
    const answered = answerKey(state.answer, request, key, pageHeight);
    if (answered.handled) {
      const resolved = answered.effects.some(
        (effect) => effect.kind === "command" && effect.payload.type === "interaction.resolve",
      );
      if (!resolved) return step({ ...state, answer: answered.state }, ...answered.effects);
      return step(
        {
          ...state,
          index,
          answer: answerStart,
          answered: [...state.answered, request.interaction.id].slice(-64),
          notice: undefined,
        },
        ...answered.effects,
      );
    }
  }
  if (key.name === "escape" || typed(key) === "q") return step(state, { kind: "home" });
  if (key.name === "right" || key.name === "tab" || typed(key) === "l")
    return stay({ ...state, index: Math.min(list.length - 1, index + 1), answer: answerStart });
  if (key.name === "left" || key.name === "backtab" || typed(key) === "h")
    return stay({ ...state, index: Math.max(0, index - 1), answer: answerStart });
  return stay(state);
}

/** The requests walk drawn at `width`. */
export function requestsView(
  state: RequestsState,
  requests: readonly OpenRequest[],
  width: number,
  height: number,
  paint: Paint,
): StripView {
  const { list, index, request } = current(state, requests);
  if (!request)
    return {
      lines: [
        "Nothing is waiting on you.",
        ...(state.notice ? [paint.dim(cutEnd(state.notice, width))] : []),
        keysLine(["esc home"], width),
      ],
    };
  const counter = `${index + 1} of ${list.length}`;
  const place = cutEnd(
    `${request.project} · ${request.threadTitle}`,
    Math.max(4, width - textWidth(counter) - 3),
  );
  const header = `${padEnd(place, Math.max(0, width - textWidth(counter) - 1))} ${paint.dim(counter)}`;
  const strip = requestStrip(
    request,
    answerFor(state.answer, request),
    width,
    paint,
    Math.max(3, height - 4),
  );
  const nav: string[] = [];
  if (index > 0) nav.push("← back");
  if (index < list.length - 1) nav.push("→ next");
  nav.push("esc home");
  const lines = [header, ...strip.lines];
  if (state.notice) lines.push(paint.dim(cutEnd(state.notice, width)));
  if (!capturing(state.answer)) lines.push(paint.dim(keysLine(nav, width)));
  return {
    lines,
    cursor: strip.cursor && { row: strip.cursor.row + 1, column: strip.cursor.column },
  };
}
