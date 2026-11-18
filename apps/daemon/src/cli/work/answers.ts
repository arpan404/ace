import type { Interaction, InteractionResolution, Question } from "@ace/protocol";
import { CliFailure, usageFailure } from "../output.ts";

/**
 * How `ace request allow|deny|answer` reply to a request (ADR 0178 §7): pure, from the
 * request and what the person typed, to the resolution the daemon records.
 */
export interface AllowInput {
  /** Allow from now on, where the request offers it. */
  readonly always?: boolean;
  /** One of the request's own option ids. */
  readonly option?: string | undefined;
}

function closed(interaction: Interaction): CliFailure | undefined {
  if (interaction.state === "pending") return undefined;
  return new CliFailure(
    "refused",
    `Request ${interaction.id} is already ${interaction.state}.`,
    undefined,
    {
      code: "conflict",
      hint: "See what's still open with ace request list.",
    },
  );
}

function wrongVerb(interaction: Interaction, verb: string, instead: string): CliFailure {
  return usageFailure(
    `Request ${interaction.id} is a ${words(interaction.request.kind)}; ace request ${verb} doesn't answer it.`,
    { argument: "REQUEST", hint: `Use ${instead} ${interaction.id}.` },
  );
}

function words(kind: Interaction["request"]["kind"]): string {
  return kind === "plan_review"
    ? "plan review"
    : kind === "browser_help"
      ? "browser request"
      : kind;
}

function pickOption(
  interaction: Interaction & { request: { kind: "approval" } },
  wanted: (kind: string) => boolean,
  selected: string | undefined,
  label: string,
): InteractionResolution {
  const options = interaction.request.options;
  const choice = selected
    ? options.find((option) => option.id === selected)
    : options.find((option) => wanted(option.kind));
  if (!choice || !wanted(choice.kind))
    throw usageFailure(
      selected
        ? `${selected} isn't a way to ${label} request ${interaction.id}.`
        : `Request ${interaction.id} has no option to ${label} it that way.`,
      {
        argument: "--option",
        hint: `Its options: ${options.map((option) => `${option.id} (${option.label})`).join(", ")}.`,
      },
    );
  return { kind: "approval", optionId: choice.id };
}

export function allowResolution(
  interaction: Interaction,
  input: AllowInput,
): InteractionResolution {
  const done = closed(interaction);
  if (done) throw done;
  const request = interaction.request;
  switch (request.kind) {
    case "approval": {
      const kinds = input.always ? ["allow_always", "allow_session"] : ["allow_once"];
      // Without a once option, a plain allow takes the request's first allow option.
      const any =
        input.option !== undefined ||
        (!input.always && !request.options.some((option) => kinds.includes(option.kind)));
      return pickOption(
        { ...interaction, request },
        (kind) => (any ? kind.startsWith("allow_") : kinds.includes(kind)),
        input.option,
        "allow",
      );
    }
    case "plan_review":
      return { kind: "plan_review", decision: "approve" };
    case "elicitation":
      if (request.mode === "url" || request.schema === undefined)
        return { kind: "elicitation", action: "accept" };
      throw wrongVerb(interaction, "allow", "ace request answer");
    case "question":
      throw wrongVerb(interaction, "allow", "ace request answer");
    case "browser_help":
      return { kind: "browser_help", outcome: "done" };
  }
}

export function denyResolution(
  interaction: Interaction,
  input: { readonly option?: string | undefined; readonly feedback?: string | undefined },
): InteractionResolution {
  const done = closed(interaction);
  if (done) throw done;
  const request = interaction.request;
  switch (request.kind) {
    case "approval":
      return pickOption(
        { ...interaction, request },
        (kind) =>
          (input.option ? ["deny", "deny_always", "cancel"] : ["deny", "cancel"]).includes(kind),
        input.option,
        "deny",
      );
    case "plan_review":
      return {
        kind: "plan_review",
        decision: "reject",
        ...(input.feedback ? { feedback: input.feedback } : {}),
      };
    case "elicitation":
      return { kind: "elicitation", action: "decline" };
    case "question":
      return {
        kind: "question",
        answers: {},
        dismissed: true,
        ...(input.feedback ? { feedback: input.feedback } : {}),
      };
    case "browser_help":
      return { kind: "browser_help", outcome: "skipped" };
  }
}

export interface AnswerInput {
  /** Free text: the answer to a question that takes one, or plan feedback. */
  readonly text?: string | undefined;
  /** Option ids, or `QUESTION=OPTION` for one of several questions. */
  readonly choices: readonly string[];
}

/**
 * The answer to a question (every question needs one: a choice, or text where it allows its
 * own), or an elicitation's content. Pure.
 */
export function answerResolution(
  interaction: Interaction,
  input: AnswerInput,
): InteractionResolution {
  const done = closed(interaction);
  if (done) throw done;
  const request = interaction.request;
  if (request.kind === "elicitation") {
    if (input.text === undefined)
      throw usageFailure(`Request ${interaction.id} needs an answer.`, {
        code: "missing_argument",
        argument: "TEXT",
        hint: `Pass it: ace request answer ${interaction.id} TEXT, or - to read it from stdin.`,
      });
    return { kind: "elicitation", action: "accept", content: elicitationContent(input.text) };
  }
  if (request.kind !== "question")
    throw wrongVerb(interaction, "answer", "ace request allow (or deny)");
  const answers: Record<string, string[]> = {};
  const loose: string[] = [];
  for (const choice of input.choices) {
    const at = choice.indexOf("=");
    if (at > 0) {
      const question = choice.slice(0, at);
      answers[question] = [...(answers[question] ?? []), choice.slice(at + 1)];
    } else loose.push(choice);
  }
  for (const question of request.questions) {
    const given = answers[question.id];
    if (given) answers[question.id] = checkChoices(question, given);
  }
  const unanswered = request.questions.filter((question) => !answers[question.id]);
  for (const question of unanswered) {
    const mine = loose.filter((choice) => question.options.some((option) => option.id === choice));
    if (mine.length) answers[question.id] = checkChoices(question, mine);
    else if (input.text !== undefined && takesText(question)) answers[question.id] = [input.text];
  }
  const missing = request.questions.find((question) => !answers[question.id]);
  if (missing)
    throw usageFailure(`"${missing.text}" needs an answer.`, {
      code: "missing_argument",
      argument: takesText(missing) ? "TEXT" : "--choice",
      hint: missing.options.length
        ? `Pick with --choice ${request.questions.length > 1 ? `${missing.id}=` : ""}ID: ${missing.options.map((option) => option.id).join(", ")}.`
        : `Pass it: ace request answer ${interaction.id} TEXT.`,
    });
  const unknown = Object.keys(answers).find(
    (id) => !request.questions.some((question) => question.id === id),
  );
  if (unknown)
    throw usageFailure(`Request ${interaction.id} has no question ${unknown}.`, {
      argument: "--choice",
    });
  return { kind: "question", answers };
}

function checkChoices(question: Question, given: readonly string[]): string[] {
  const known = new Set(question.options.map((option) => option.id));
  const bad = given.find((choice) => !known.has(choice) && !takesText(question));
  if (bad)
    throw usageFailure(`${bad} isn't a choice for "${question.text}".`, {
      argument: "--choice",
      hint: `Its choices: ${question.options.map((option) => option.id).join(", ")}.`,
    });
  if (!question.multiSelect && given.length > 1)
    throw usageFailure(`"${question.text}" takes one choice.`, { argument: "--choice" });
  return [...given];
}

/** A question answered in words: it allows its own answer, or offers no choices at all. */
function takesText(question: Question): boolean {
  return question.allowOther || question.options.length === 0;
}

/** An elicitation's answer: JSON when it reads as JSON, else the text itself. */
function elicitationContent(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
