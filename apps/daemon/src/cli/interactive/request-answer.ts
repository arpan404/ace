import {
  InteractionId,
  type Interaction,
  type InteractionResolution,
  type ProviderKind,
} from "@ace/protocol";
import { approvalByKey, approvalCopy, type ApprovalVerb } from "@ace/ui-core";
import { composerKey, emptyComposer, type Composer } from "../tui/composer.ts";
import { typed, type Key } from "../tui/keys.ts";
import type { Effect } from "./effects.ts";

/**
 * Answering one open request from the keyboard (ADR 0176 §9), shared by the requests walk and
 * attach. Pure. Approvals answer with `y` Allow once, `n` Deny, `a` Always allow and `↵`
 * details; questions with their choices' numbers or a typed answer; plans in a pager, then
 * `y` Approve or `n` Ask for changes. The words and options come from `@ace/ui-core`'s
 * `approvalCopy`, the app's own card.
 */
export interface OpenRequest {
  readonly interaction: Interaction;
  readonly threadTitle: string;
  readonly project: string;
  readonly provider: ProviderKind;
}

export type AnswerMode = "strip" | "details" | "plan" | "typing";

export interface AnswerState {
  readonly id: string | undefined;
  readonly mode: AnswerMode;
  readonly composer: Composer;
  /** Which of a question request's questions is being asked, and the answers so far. */
  readonly question: number;
  readonly answers: Readonly<Record<string, readonly string[]>>;
  /** Choices toggled on a multi-select question. */
  readonly picked: readonly string[];
  /** The pager's first line, for plans and details. */
  readonly scroll: number;
  /** One line saying why a key did nothing ("This one needs a deliberate yes…"). */
  readonly notice: string | undefined;
}

export const answerStart: AnswerState = {
  id: undefined,
  mode: "strip",
  composer: emptyComposer,
  question: 0,
  answers: {},
  picked: [],
  scroll: 0,
  notice: undefined,
};

/** The state for `request`: kept while it is the same request, fresh for a new one. */
export function answerFor(state: AnswerState, request: OpenRequest | undefined): AnswerState {
  const id = request?.interaction.id;
  return state.id === id ? state : { ...answerStart, id };
}

export interface AnswerStep {
  readonly state: AnswerState;
  readonly effects: readonly Effect[];
  /** False when the key means nothing here, so the caller may use it (→ next, Esc home). */
  readonly handled: boolean;
}

function resolve(
  request: OpenRequest,
  resolution: InteractionResolution,
  doneText: string,
): Effect {
  return {
    kind: "command",
    payload: {
      type: "interaction.resolve",
      interactionId: InteractionId.parse(request.interaction.id),
      resolution,
    },
    done: doneText,
  };
}

const handled = (state: AnswerState, ...effects: Effect[]): AnswerStep => ({
  state,
  effects,
  handled: true,
});
const unhandled = (state: AnswerState): AnswerStep => ({ state, effects: [], handled: false });

const verbs: Record<string, ApprovalVerb> = { y: "allow_once", n: "deny", a: "always_allow" };

function approvalKey(state: AnswerState, request: OpenRequest, key: Key): AnswerStep {
  const ask = request.interaction.request;
  if (ask.kind !== "approval") return unhandled(state);
  if (key.name === "enter")
    return handled({ ...state, mode: state.mode === "details" ? "strip" : "details", notice: undefined });
  const verb = verbs[typed(key) ?? ""];
  if (!verb) return unhandled(state);
  const copy = approvalCopy(ask);
  const decision = copy.decisions.find((candidate) => candidate.verb === verb);
  if (!decision) return handled({ ...state, notice: "This request doesn't offer that answer." });
  // A high-risk or default-to-no request takes a key only to refuse, unless its details are open.
  if (verb !== "deny" && state.mode !== "details" && !approvalByKey(ask, decision.option, copy.risk))
    return handled({
      ...state,
      mode: "details",
      notice: `This one needs a deliberate yes: read it, then press ${typed(key)} again.`,
    });
  return handled(
    { ...state, notice: undefined },
    resolve(request, { kind: "approval", optionId: decision.option.id }, `${decision.label}: ${copy.title}`),
  );
}

function questionKey(state: AnswerState, request: OpenRequest, key: Key): AnswerStep {
  const ask = request.interaction.request;
  if (ask.kind !== "question") return unhandled(state);
  const question = ask.questions[state.question];
  if (!question) return unhandled(state);
  const answer = (values: readonly string[]): AnswerStep => {
    const answers = { ...state.answers, [question.id]: [...values] };
    const next = state.question + 1;
    if (next < ask.questions.length)
      return handled({ ...state, answers, question: next, picked: [], mode: "strip", composer: emptyComposer });
    return handled(
      { ...state, answers, picked: [], mode: "strip", composer: emptyComposer },
      resolve(request, { kind: "question", answers }, "Answered."),
    );
  };
  if (state.mode === "typing") {
    if (key.name === "escape") return handled({ ...state, mode: "strip", composer: emptyComposer });
    const edit = composerKey(state.composer, key);
    if (edit.kind === "submit") return edit.text.trim() ? answer([edit.text.trim()]) : handled(state);
    return handled({ ...state, composer: edit.composer });
  }
  const char = typed(key);
  const number = char && /^[1-9]$/.test(char) ? Number(char) : undefined;
  const typeChoice = question.options.length + 1;
  if (number === typeChoice || (char === "t" && question.options.length < 9))
    return handled({ ...state, mode: "typing", composer: emptyComposer });
  if (number !== undefined) {
    const option = question.options[number - 1];
    if (!option) return handled(state);
    if (!question.multiSelect) return answer([option.id]);
    const picked = state.picked.includes(option.id)
      ? state.picked.filter((id) => id !== option.id)
      : [...state.picked, option.id];
    return handled({ ...state, picked });
  }
  if (key.name === "enter" && question.multiSelect && state.picked.length) return answer(state.picked);
  return unhandled(state);
}

function planKey(state: AnswerState, request: OpenRequest, key: Key, pageHeight: number): AnswerStep {
  if (request.interaction.request.kind !== "plan_review") return unhandled(state);
  if (state.mode === "typing") {
    if (key.name === "escape") return handled({ ...state, mode: "plan", composer: emptyComposer });
    const edit = composerKey(state.composer, key);
    if (edit.kind === "submit")
      return handled(
        { ...state, mode: "strip", composer: emptyComposer },
        resolve(
          request,
          { kind: "plan_review", decision: "reject", ...(edit.text.trim() ? { feedback: edit.text.trim() } : {}) },
          "Asked for changes to the plan.",
        ),
      );
    return handled({ ...state, composer: edit.composer });
  }
  const char = typed(key);
  if (state.mode !== "plan") {
    if (key.name === "enter") return handled({ ...state, mode: "plan", scroll: 0 });
    if (char !== "y" && char !== "n") return unhandled(state);
  }
  if (state.mode === "plan") {
    if (key.name === "down" || char === "j") return handled({ ...state, scroll: state.scroll + 1 });
    if (key.name === "up" || char === "k") return handled({ ...state, scroll: Math.max(0, state.scroll - 1) });
    if (char === " " || key.name === "pagedown")
      return handled({ ...state, scroll: state.scroll + Math.max(1, pageHeight - 1) });
    if (key.name === "pageup")
      return handled({ ...state, scroll: Math.max(0, state.scroll - Math.max(1, pageHeight - 1)) });
    if (key.name === "escape" || key.name === "enter") return handled({ ...state, mode: "strip" });
  }
  if (char === "y")
    return handled(
      { ...state, mode: "strip" },
      resolve(request, { kind: "plan_review", decision: "approve" }, "Approved the plan."),
    );
  if (char === "n") return handled({ ...state, mode: "typing", composer: emptyComposer });
  return state.mode === "plan" ? handled(state) : unhandled(state);
}

/** One key for the open request. `pageHeight` is how many plan lines the pager shows. */
export function answerKey(
  state: AnswerState,
  request: OpenRequest,
  key: Key,
  pageHeight = 10,
): AnswerStep {
  const fresh = answerFor(state, request);
  switch (request.interaction.request.kind) {
    case "approval":
      return approvalKey(fresh, request, key);
    case "question":
      return questionKey(fresh, request, key);
    case "plan_review":
      return planKey(fresh, request, key, pageHeight);
    case "elicitation":
      if (typed(key) === "n")
        return handled(fresh, resolve(request, { kind: "elicitation", action: "decline" }, "Declined."));
      return unhandled(fresh);
    default:
      return unhandled(fresh);
  }
}

/** The answer is being typed: keys go to its composer, not to navigation. */
export function capturing(state: AnswerState): boolean {
  return state.mode === "typing" || state.mode === "plan";
}
