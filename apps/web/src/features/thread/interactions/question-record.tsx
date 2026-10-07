import { useAgent, useInteraction } from "@ace/client-react";
import type { InteractionResolution, Question } from "@ace/protocol";
import { agentName, answeredQuestions, questionTitle, requestIdentity } from "@ace/ui-core";
import { CaretDownIcon, CheckIcon, ChatCircleDotsIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { AnsweredQuestionCard, closedMeta, type AnsweredMeta } from "./answered-question.tsx";
import { useLocalAnswer } from "./answers.ts";
import { useEarlierAnswer } from "./use-earlier-answer.ts";

/** The answer a question got, in a few words: the options picked and anything typed. */
function answerWords(questions: readonly Question[], resolution: InteractionResolution): string {
  const answers = resolution.kind === "question" ? resolution.answers : {};
  return answeredQuestions(questions, answers)
    .map((row) => [...row.chosen.map((option) => option.label), ...row.typed].join(", "))
    .filter(Boolean)
    .join("; ");
}

/** Where the card it is answered on lives: the deck attached to the composer. */
function focusAnswerCard() {
  const card = document.querySelector("section[aria-label='Waiting for you']");
  const answer =
    card?.querySelector<HTMLElement>("input:not([disabled]), button[aria-keyshortcuts]") ??
    card?.querySelector<HTMLElement>("button:not([disabled]):not([data-slot='icon-button'])");
  answer?.focus();
}

/**
 * A question in the transcript where the agent asked it (IR-1), as one quiet line: while it is
 * open, that the agent is asking and where to answer (the card on the composer); once answered,
 * the question beside its answer, opening to every question and option. Never a form here.
 */
export function QuestionRecord(props: { threadId: string; interactionId: string }) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  const agent = useAgent(props.threadId, interaction?.agentId ?? "");
  const identity = interaction ? requestIdentity(interaction) : undefined;
  const local = useLocalAnswer(props.interactionId, identity);
  const earlier = useEarlierAnswer(props.threadId, interaction);
  const [open, setOpen] = useState(false);
  const details = useId();
  if (!interaction || interaction.request.kind !== "question") return null;
  const questions = interaction.request.questions;
  const asker = agent ? agentName(agent) : "The agent";
  const title = questionTitle(questions);
  const pending = interaction.state === "pending";
  const resolution =
    interaction.resolution ?? local?.resolution ?? (pending ? earlier?.resolution : undefined);
  const meta: AnsweredMeta | undefined = !pending
    ? closedMeta(interaction, local?.state === "sent")
    : local
      ? local.state === "sending"
        ? { kind: "sending" }
        : { kind: "answered", by: "you", at: local.at }
      : earlier
        ? { kind: "earlier", at: earlier.closedAt }
        : undefined;
  const waiting = pending && !meta;
  const answer = resolution && meta?.kind !== "skipped" ? answerWords(questions, resolution) : "";
  const outcome = !meta
    ? undefined
    : meta.kind === "skipped"
      ? "Skipped"
      : meta.kind === "expired"
        ? "Expired before an answer"
        : meta.kind === "cancelled"
          ? "Withdrawn by the agent"
          : meta.kind === "sending"
            ? "Sending…"
            : undefined;
  return (
    <div role="group" aria-label={`Question: ${title}`} className="text-ui">
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {waiting ? (
          <ChatCircleDotsIcon aria-hidden size={14} className="shrink-0 text-status-needs-you" />
        ) : answer ? (
          <CheckIcon aria-hidden size={14} className="shrink-0 text-status-done" />
        ) : (
          <ChatCircleDotsIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
        )}
        <p className="min-w-0 truncate">
          <span className="text-subtle-foreground">
            {asker} {waiting ? "is asking" : "asked"} ·{" "}
          </span>
          <span className="text-foreground">{title}</span>
          {answer && (
            <>
              <span aria-hidden className="text-subtle-foreground">
                {" "}
                →{" "}
              </span>
              <span className="sr-only">, answered: </span>
              <span className="font-medium text-foreground">{answer}</span>
            </>
          )}
          {outcome && <span className="text-subtle-foreground"> · {outcome}</span>}
        </p>
        {waiting ? (
          <button
            type="button"
            onClick={focusAnswerCard}
            className="ml-auto shrink-0 rounded-xs text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-ring"
          >
            Answer below
          </button>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={details}
            aria-label={open ? "Hide the question" : "Show the question and answer"}
            onClick={() => setOpen(!open)}
            className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-sm text-subtle-foreground hover:bg-accent hover:text-foreground focus-ring"
          >
            <CaretDownIcon
              aria-hidden
              size={12}
              className={cn("transition-transform duration-(--dur-1)", open && "rotate-180")}
            />
          </button>
        )}
      </div>
      {open && meta && (
        <div id={details} className="fx-rise-in mt-2">
          <AnsweredQuestionCard
            asker={asker}
            questions={questions}
            resolution={resolution}
            meta={meta}
          />
        </div>
      )}
    </div>
  );
}
