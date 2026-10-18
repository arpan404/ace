import { useAgent, useInteraction } from "@ace/client-react";
import type { InteractionResolution, Question } from "@ace/protocol";
import { agentName, answeredQuestions, questionTitle, requestIdentity } from "@ace/ui-core";
import { ArrowRightIcon, CheckIcon, ChatCircleDotsIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { pressableRowClass } from "../items/transcript-row.tsx";
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

/**
 * A question in the transcript where the agent asked it (IR-1), as one quiet row once answered:
 * the question beside its answer, the whole row opening to every question and option. While it
 * is open it has no row here; it is answered on the card above the composer. Never a form here.
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
  if (waiting) return null;
  return (
    <div role="group" aria-label={`Question: ${title}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={details}
        aria-label={open ? "Hide the question" : "Show the question and answer"}
        onClick={() => setOpen(!open)}
        className={cn(pressableRowClass, "text-muted-foreground")}
      >
        <span className="flex min-w-5 shrink-0 items-center justify-center">
          {answer ? (
            <CheckIcon aria-hidden size={16} className="text-status-done" />
          ) : (
            <ChatCircleDotsIcon aria-hidden size={16} className="text-subtle-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-subtle-foreground">{asker} asked · </span>
          <span className="text-foreground">{title}</span>
          {answer && (
            <>
              <ArrowRightIcon
                aria-hidden
                size={12}
                className="mx-1 inline-block align-[-1px] text-subtle-foreground"
              />
              <span className="sr-only">, answered: </span>
              <span className="font-medium text-foreground">{answer}</span>
            </>
          )}
          {outcome && <span className="text-subtle-foreground"> · {outcome}</span>}
        </span>
      </button>
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
