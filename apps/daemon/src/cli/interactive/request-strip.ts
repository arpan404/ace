import { approvalCopy, providerDisplayName } from "@ace/ui-core";
import { composerView } from "../tui/composer.ts";
import { cutEnd, cutMiddle, safeText, wrap } from "../tui/layout.ts";
import type { Paint } from "../tui/paint.ts";
import { answerFor, type AnswerState, type OpenRequest } from "./request-answer.ts";

/**
 * One open request drawn as the app's request strip (ADR 0178 §9): who asks and one sentence,
 * one line of detail (a command cut in the middle), then the answers as keys spaced apart.
 * Pure. `pageHeight` bounds the plan pager.
 */
export interface StripView {
  readonly lines: string[];
  /** Where the cursor goes while an answer is typed. */
  readonly cursor?: { row: number; column: number } | undefined;
}

const spaced = (keys: readonly string[]) => keys.join("    ");

function typingLines(
  lines: string[],
  state: AnswerState,
  width: number,
  hint: string,
  paint: Paint,
): StripView {
  const view = composerView(state.composer, width - 2, paint.dim(hint));
  const row = lines.length + view.cursor.row;
  return {
    lines: [...lines, ...view.lines.map((line) => `  ${line}`), paint.dim("  ↵ send · esc back")],
    cursor: { row, column: view.cursor.column + 2 },
  };
}

export function requestStrip(
  request: OpenRequest,
  given: AnswerState,
  width: number,
  paint: Paint,
  pageHeight = 10,
): StripView {
  const state = answerFor(given, request);
  const ask = request.interaction.request;
  const who = providerDisplayName(request.provider);
  const room = Math.max(10, width - 2);
  const mark = (glyph: string) => paint.tone("needs-you", glyph);
  const notice = state.notice ? [paint.dim(`  ${cutEnd(state.notice, room)}`)] : [];
  if (ask.kind === "approval") {
    const copy = approvalCopy(ask);
    const detail = copy.command ?? (copy.title !== copy.heading ? copy.title : copy.reason);
    const lines = [cutEnd(`${mark("◆")} ${who}: ${safeText(copy.heading)}`, width)];
    if (detail) lines.push(`  ${paint.dim(cutMiddle(safeText(detail), room))}`);
    if (state.mode === "details") {
      if (copy.reason && copy.reason !== detail)
        lines.push(...wrap(safeText(copy.reason), room).map((line) => `  ${line}`));
      if (copy.risk)
        lines.push(
          `  ${paint.tone(copy.risk.level === "high" ? "failed" : "needs-you", cutEnd(safeText(copy.risk.text), room))}`,
        );
      for (const fact of copy.facts)
        lines.push(`  ${cutEnd(`${fact.label}: ${safeText(fact.value)}`, room)}`);
      for (const file of copy.files) lines.push(`  ${paint.dim(cutMiddle(file, room))}`);
      if (copy.code)
        lines.push(
          ...wrap(safeText(copy.code), room)
            .slice(0, 12)
            .map((line) => `  ${paint.dim(line)}`),
        );
    }
    const keys = copy.decisions.map((decision) => {
      const letter = decision.verb === "allow_once" ? "y" : decision.verb === "deny" ? "n" : "a";
      return `${letter} ${decision.label}${decision.scope ? ` (${decision.scope})` : ""}`;
    });
    keys.push(state.mode === "details" ? "↵ less" : "↵ details");
    lines.push(`  ${cutEnd(spaced(keys), room)}`);
    return { lines: [...lines, ...notice] };
  }
  if (ask.kind === "question") {
    const question = ask.questions[state.question] ?? ask.questions[0];
    const lines = [
      cutEnd(
        `${mark("?")} ${who} has a question${ask.questions.length > 1 ? ` (${state.question + 1} of ${ask.questions.length})` : ""}`,
        width,
      ),
    ];
    if (question) {
      lines.push(...wrap(safeText(question.text), room).map((line) => `  ${line}`));
      if (state.mode === "typing") return typingLines(lines, state, width, "Type an answer", paint);
      const choices = question.options.map((option, index) => {
        const on = question.multiSelect && state.picked.includes(option.id) ? "✓" : "";
        return `${index + 1} ${on}${safeText(option.label)}`;
      });
      choices.push(`${question.options.length + 1} Type an answer`);
      lines.push(`  ${cutEnd(spaced(choices), room)}`);
      if (question.multiSelect) lines.push(paint.dim("  numbers pick · ↵ send"));
    }
    return { lines: [...lines, ...notice] };
  }
  if (ask.kind === "plan_review") {
    const title = ask.title ?? ask.summary ?? "A plan to review";
    const lines = [
      cutEnd(`${mark("◆")} ${who} has a plan for you to review`, width),
      `  ${cutEnd(safeText(title), room)}`,
    ];
    if (state.mode === "typing")
      return typingLines(
        lines,
        state,
        width,
        "What should change? (↵ sends, empty asks again)",
        paint,
      );
    if (state.mode === "plan") {
      const body = wrap(safeText(ask.markdown), room);
      const height = Math.max(3, pageHeight);
      const first = Math.min(state.scroll, Math.max(0, body.length - height));
      lines.push(...body.slice(first, first + height).map((line) => `  ${line}`));
      const shown = `lines ${first + 1}–${Math.min(body.length, first + height)} of ${body.length}`;
      lines.push(
        paint.dim(
          `  ${cutEnd(`${shown} · j k scroll · y Approve · n Ask for changes · esc back`, room)}`,
        ),
      );
      return { lines: [...lines, ...notice] };
    }
    lines.push(`  ${cutEnd(spaced(["↵ read the plan", "y Approve", "n Ask for changes"]), room)}`);
    return { lines: [...lines, ...notice] };
  }
  if (ask.kind === "elicitation")
    return {
      lines: [
        cutEnd(`${mark("?")} ${safeText(ask.server)} asks for input`, width),
        ...wrap(safeText(ask.message), room)
          .slice(0, 4)
          .map((line) => `  ${line}`),
        `  ${cutEnd(spaced(["Answer it in the app", "n Decline"]), room)}`,
      ],
    };
  return {
    lines: [
      cutEnd(`${mark("◆")} ${who} needs your help in the browser`, width),
      ...wrap(safeText(ask.message), room)
        .slice(0, 3)
        .map((line) => `  ${line}`),
      paint.dim("  Open it in the app to finish."),
    ],
  };
}
