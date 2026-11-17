import type { CliOpenRequest, Interaction, Question } from "@ace/protocol";
import type { Args } from "../args.ts";
import { usageFailure } from "../output.ts";
import { requestSentence } from "../render/request.ts";
import type { ThreadRow } from "./rows.ts";

/**
 * Asking for what's missing (ADR 0178 §9): on a terminal a picker, naming the argument that
 * would have supplied it; anywhere else a usage error (exit 64) naming it. Nothing here reads
 * stdin unless a person is at the terminal.
 */
export function missing(command: string, argument: string, hint: string) {
  return usageFailure(`${command} needs ${argument}.`, {
    code: "missing_argument",
    argument,
    hint,
  });
}

export async function pickThread(args: Args, rows: readonly ThreadRow[], command: string) {
  if (!args.interactive)
    throw missing(
      command,
      "THREAD",
      `Pass a thread id: ${command} THREAD. See them with ace thread list.`,
    );
  if (!rows.length)
    throw missing(command, "THREAD", "There are no threads yet. Start one with ace run.");
  const { askSelect } = await import("../ask.ts");
  return askSelect(
    `Which thread? (or pass it: ${command} THREAD)`,
    rows.slice(0, 50).map((row) => ({
      value: row.threadId,
      label: row.title,
      hint: [row.meaning, row.project].filter(Boolean).join(" · "),
    })),
  );
}

export async function pickRequest(
  args: Args,
  open: readonly CliOpenRequest[],
  command: string,
): Promise<CliOpenRequest> {
  const only = open.length === 1 ? open[0] : undefined;
  if (!args.interactive) {
    if (only && args.flags.thread !== undefined) return only;
    throw missing(
      command,
      "REQUEST",
      `Pass a request id: ${command} REQUEST. See them with ace request list.`,
    );
  }
  if (!open.length) throw missing(command, "REQUEST", "Nothing needs you right now.");
  if (only && args.flags.thread !== undefined) return only;
  const { askSelect } = await import("../ask.ts");
  const id = await askSelect(
    `Which request? (or pass it: ${command} REQUEST)`,
    open.map((each) => ({
      value: each.interaction.id,
      label: requestSentence(each.interaction),
      hint: each.threadTitle,
    })),
  );
  const picked = open.find((each) => each.interaction.id === id);
  if (!picked)
    throw missing(
      command,
      "REQUEST",
      "That request closed; see what's open with ace request list.",
    );
  return picked;
}

/**
 * The answers a person gives at the terminal for the questions `--choice` and TEXT left
 * open, as `--choice QUESTION=ID` values.
 */
export async function askQuestions(
  interaction: Interaction,
  given: readonly string[],
): Promise<string[]> {
  if (interaction.request.kind !== "question") return [...given];
  const { askSelect, askText } = await import("../ask.ts");
  const answered = new Set(given.map((choice) => choice.split("=")[0]));
  const loose = new Set(given.filter((choice) => !choice.includes("=")));
  const out = [...given];
  for (const question of interaction.request.questions) {
    if (answered.has(question.id)) continue;
    if (question.options.some((option) => loose.has(option.id))) continue;
    out.push(...(await askOne(question, askSelect, askText)));
  }
  return out;
}

const typed = "__typed__";

async function askOne(
  question: Question,
  askSelect: typeof import("../ask.ts").askSelect,
  askText: typeof import("../ask.ts").askText,
): Promise<string[]> {
  const hint = `--choice ${question.id}=ID`;
  if (!question.options.length)
    return [`${question.id}=${await askText(question.text, `Or pass the answer as TEXT`)}`];
  const choice = await askSelect(`${question.text} (or pass ${hint})`, [
    ...question.options.map((option) => ({
      value: option.id,
      label: option.label,
      ...(option.description ? { hint: option.description } : {}),
    })),
    ...(question.allowOther ? [{ value: typed, label: "Type an answer" }] : []),
  ]);
  if (choice !== typed) return [`${question.id}=${choice}`];
  return [`${question.id}=${await askText(question.text, "Or pass the answer as TEXT")}`];
}
