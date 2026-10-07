import type { Interaction, InteractionResolution, Question } from "@ace/protocol";
import { answeredQuestions, formatClock, type AnsweredQuestion } from "@ace/ui-core";
import { CheckIcon, QuotesIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";

export type AnsweredMeta =
  | { kind: "answered"; by: "you" | "elsewhere" | "unknown"; at: number | undefined }
  | { kind: "sending" }
  | { kind: "skipped" | "expired" | "cancelled" }
  | { kind: "earlier"; at: number | undefined };

function metaText(meta: AnsweredMeta): string {
  switch (meta.kind) {
    case "answered": {
      const who =
        meta.by === "you"
          ? "Answered by you"
          : meta.by === "elsewhere"
            ? "Answered on another device"
            : "Answered";
      return meta.at ? `${who} · ${formatClock(meta.at)}` : who;
    }
    case "earlier":
      return meta.at ? `Answered earlier · ${formatClock(meta.at)}` : "Answered earlier";
    case "sending":
      return "Sending…";
    case "skipped":
      return "Skipped";
    case "expired":
      return "Expired before an answer";
    case "cancelled":
      return "Withdrawn by the agent";
  }
}

/**
 * A question with the answer it got, read-only (IR-1): who asked, the question, the chosen
 * options as checked chips, typed text quoted, and when and where it was answered. Options not
 * chosen wait behind "Show all N options".
 */
export function AnsweredQuestionCard(props: {
  /** The card's frame; a bordered card of its own by default. */
  className?: string | undefined;
  asker: string;
  questions: readonly Question[];
  resolution: InteractionResolution | undefined;
  meta: AnsweredMeta;
  /** Offered when the agent may still be waiting (a request offered again): answer anew. */
  onAnswerAgain?: (() => void) | undefined;
}) {
  const answers = props.resolution?.kind === "question" ? props.resolution.answers : {};
  const rows = answeredQuestions(props.questions, answers);
  const title = rows.length === 1 ? rows[0]?.text : `${rows.length} questions`;
  return (
    <article
      aria-label={`Question: ${title ?? ""}`}
      className={props.className ?? "rounded-lg px-4 py-3 shadow-[inset_0_0_0_1px_var(--border)]"}
    >
      <p className="text-xs text-subtle-foreground">{props.asker} asked</p>
      <div className="mt-1.5 flex flex-col gap-3">
        {rows.map((row) => (
          <AnsweredRow key={row.id} row={row} showAnswer={props.meta.kind !== "skipped"} />
        ))}
      </div>
      <p className="mt-2 flex items-center justify-end gap-2 text-xs text-subtle-foreground">
        {props.meta.kind === "sending" && <Spinner />}
        <span>{metaText(props.meta)}</span>
        {props.onAnswerAgain && (
          <Button size="sm" variant="ghost" onClick={props.onAnswerAgain}>
            Answer again
          </Button>
        )}
      </p>
    </article>
  );
}

function AnsweredRow(props: { row: AnsweredQuestion; showAnswer: boolean }) {
  const { row } = props;
  const [all, setAll] = useState(false);
  const list = useId();
  const answered = row.chosen.length > 0 || row.typed.length > 0;
  return (
    <section aria-label={row.text}>
      {row.header && <p className="text-xs text-subtle-foreground">{row.header}</p>}
      <p className="text-ui leading-[1.45] font-medium">{row.text}</p>
      {props.showAnswer && answered && (
        <ul aria-label="Answer" className="mt-1.5 flex flex-wrap gap-1.5">
          {row.chosen.map((option) => (
            <li
              key={option.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-ui"
            >
              <CheckIcon aria-hidden size={13} className="text-status-done" />
              {option.label}
            </li>
          ))}
          {row.typed.map((text) => (
            <li
              key={text}
              className="inline-flex items-start gap-1.5 rounded-md bg-muted px-2.5 py-0.5 text-ui"
            >
              <QuotesIcon aria-hidden size={13} className="mt-1 shrink-0 text-subtle-foreground" />
              <q className="whitespace-pre-wrap [quotes:none]">{text}</q>
            </li>
          ))}
        </ul>
      )}
      {row.others.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={all}
            aria-controls={list}
            onClick={() => setAll(!all)}
            className="mt-1 text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {all ? "Hide options" : `Show all ${row.chosen.length + row.others.length} options`}
          </button>
          {all && (
            <ul id={list} className="mt-1 flex flex-col gap-0.5 text-sm text-muted-foreground">
              {[...row.chosen, ...row.others].map((option) => (
                <li
                  key={option.id}
                  className={cn(row.chosen.includes(option) && "text-foreground")}
                >
                  {option.label}
                  {option.description && (
                    <span className="text-subtle-foreground"> · {option.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** How a closed question reads, from its interaction and this device's memory of answering. */
export function closedMeta(
  interaction: Pick<Interaction, "state" | "resolution" | "resolvedBy" | "closedAt">,
  answeredHere: boolean,
): AnsweredMeta {
  const resolution = interaction.resolution;
  if (resolution?.kind === "question" && resolution.dismissed) return { kind: "skipped" };
  if (resolution || interaction.state === "resolved")
    return {
      kind: "answered",
      by: answeredHere ? "you" : interaction.resolvedBy ? "elsewhere" : "unknown",
      at: interaction.closedAt,
    };
  if (interaction.state === "expired") return { kind: "expired" };
  return { kind: "cancelled" };
}
