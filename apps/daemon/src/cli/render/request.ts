import type { CliOpenRequest, CliRequestList, Interaction } from "@ace/protocol";
import { formatAge } from "@ace/ui-core/time";
import { shortIds } from "../work/refs.ts";
import { paint } from "./thread-glyph.ts";

/** The glyph a request shows: `?` for a question, `◆` for anything else that needs you. */
export function requestGlyph(interaction: Pick<Interaction, "request">): string {
  return interaction.request.kind === "question" ? "?" : "◆";
}

/** What the request asks, in one sentence. Pure. */
export function requestSentence(interaction: Pick<Interaction, "request">): string {
  const request = interaction.request;
  switch (request.kind) {
    case "approval":
      return request.title;
    case "question": {
      const [first] = request.questions;
      const more = request.questions.length - 1;
      return `${first?.text ?? "A question"}${more > 0 ? ` (and ${more} more)` : ""}`;
    }
    case "plan_review":
      return `Review the plan${request.title ? `: ${request.title}` : ""}`;
    case "elicitation":
      return `${request.server} asks: ${request.title ?? request.message}`;
    case "browser_help":
      return request.message || "Help in the browser";
  }
}

/** The verbs that answer it, as the commands to type. */
export function requestAnswers(interaction: Pick<Interaction, "request">, ref: string): string {
  switch (interaction.request.kind) {
    case "question":
      return `ace request answer ${ref}`;
    case "elicitation":
      return `ace request answer ${ref}, or ace request deny ${ref}`;
    case "browser_help":
      return "Finish it in the app's browser";
    default:
      return `ace request allow ${ref}, or ace request deny ${ref}`;
  }
}

/** A request on one line, under a thread: glyph, sentence, how to answer. */
export function requestLine(interaction: Interaction, colour: boolean): string {
  return `${paint(requestGlyph(interaction), "needs-you", colour)} ${requestSentence(interaction)}  ${requestAnswers(interaction, interaction.id)}`;
}

export function requestListLines(
  list: CliRequestList,
  options: { now: number; colour: boolean; projectNames?: ReadonlyMap<string, string> },
): string[] {
  if (!list.requests.length) return ["Nothing needs you."];
  const ids = shortIds(list.requests.map((each) => each.interaction.id));
  const idWidth = Math.max(
    ...list.requests.map((each) => (ids.get(each.interaction.id) ?? "").length),
  );
  const lines = list.requests.map((each) => {
    const id = ids.get(each.interaction.id) ?? each.interaction.id;
    const project = options.projectNames?.get(each.workspaceId) ?? "";
    const where = [project, each.threadTitle].filter(Boolean).join(" · ");
    return [
      paint(requestGlyph(each.interaction), "needs-you", options.colour),
      id.padEnd(idWidth),
      requestSentence(each.interaction),
      ` ${where}`,
      formatAge(each.interaction.createdAt, options.now),
    ].join("  ");
  });
  if (list.truncated) lines.push("More are open; answer these first, or narrow with --thread.");
  return lines;
}

/** One request in full: what it asks, its choices, and how to answer it. Pure. */
export function requestShowLines(open: CliOpenRequest, colour: boolean): string[] {
  const { interaction } = open;
  const request = interaction.request;
  const lines = [
    `${paint(requestGlyph(interaction), "needs-you", colour)} ${requestSentence(interaction)}`,
    `${interaction.id}  in ${open.threadTitle} (${open.threadId})  ${open.provider}`,
  ];
  if (interaction.truncated) lines.push("This request is long; allowing it reads it whole first.");
  switch (request.kind) {
    case "approval":
      if (request.description)
        lines.push("", ...request.description.trimEnd().split("\n").slice(0, 20));
      lines.push("", ...request.options.map((option) => `  ${option.id}  ${option.label}`));
      break;
    case "question":
      for (const question of request.questions) {
        lines.push(
          "",
          `${question.header ? `${question.header}: ` : ""}${question.text}  (${question.id})`,
        );
        for (const option of question.options)
          lines.push(
            `  ${option.id}  ${option.label}${option.description ? ` · ${option.description}` : ""}`,
          );
        if (question.allowOther) lines.push("  Or type your own answer.");
        if (question.multiSelect) lines.push("  Pick any number, with --choice for each.");
      }
      break;
    case "plan_review":
      lines.push("", ...request.markdown.trimEnd().split("\n").slice(0, 60));
      break;
    case "elicitation":
      lines.push("", request.message, ...(request.url ? [request.url] : []));
      break;
    case "browser_help":
      if (request.url) lines.push("", request.url);
      break;
  }
  lines.push("", requestAnswers(interaction, interaction.id));
  return lines;
}
