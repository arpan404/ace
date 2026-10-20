import { useAgent, useInteraction } from "@ace/client-react";
import type { Interaction, InteractionResolution, Question } from "@ace/protocol";
import { agentName, answeredQuestions, questionTitle, requestIdentity } from "@ace/ui-core";
import { ArrowRightIcon, ChatTeardropDotsIcon, ChatTeardropTextIcon } from "@phosphor-icons/react";
import { useId, useState, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { RailMark } from "../items/step-rail.tsx";
import { pressableRowClass } from "../items/transcript-row.tsx";
import { AnsweredQuestionCard, closedMeta, type AnsweredMeta } from "./answered-question.tsx";
import { useLocalAnswer } from "./answers.ts";
import { focusRequest } from "./request-focus.ts";
import { useEarlierAnswer } from "./use-earlier-answer.ts";
import { useItemInteraction } from "./use-item-interaction.ts";

/** The answer a question got, in a few words: the options picked and anything typed. */
function answerWords(questions: readonly Question[], resolution: InteractionResolution): string {
  const answers = resolution.kind === "question" ? resolution.answers : {};
  return answeredQuestions(questions, answers)
    .map((row) => [...row.chosen.map((option) => option.label), ...row.typed].join(", "))
    .filter(Boolean)
    .join("; ");
}

/** How a closed question's line ends when it got no answer to show. */
function outcomeWords(meta: AnsweredMeta, resolution: InteractionResolution | undefined) {
  switch (meta.kind) {
    case "skipped": {
      const note = resolution?.kind === "question" ? resolution.feedback?.trim() : undefined;
      return note ? `Skipped · “${note}”` : "Skipped";
    }
    case "expired":
      return "Expired before an answer";
    case "cancelled":
      return "Withdrawn by the agent";
    case "sending":
      return "Sending…";
    default:
      return undefined;
  }
}

/**
 * A question in the transcript where the agent asked it (IR-1). While it waits, one line saying
 * the agent is asking, which brings up its card on the composer to answer it. Once answered, one
 * quiet line with the question beside its answer, opening to every question and option.
 */
export function QuestionRecord(props: { threadId: string; interactionId: string }) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  if (interaction?.request.kind !== "question") return null;
  return <QuestionLine threadId={props.threadId} interaction={interaction} />;
}

/**
 * The `ask_user` step of a work log, once its question has closed: the question with its
 * answer, as the transcript line reads. `fallback` (the plain step) without its interaction.
 * A question still waiting has its own line outside the log, so it adds none here.
 */
export function QuestionStep(props: { threadId: string; itemId: string; fallback: ReactNode }) {
  const interaction = useItemInteraction(props.threadId, props.itemId);
  if (interaction?.request.kind !== "question") return props.fallback;
  return (
    <li className="relative">
      <RailMark state="done" />
      <QuestionLine threadId={props.threadId} interaction={interaction} inLog />
    </li>
  );
}

function QuestionLine(props: { threadId: string; interaction: Interaction; inLog?: boolean }) {
  const { interaction } = props;
  const agent = useAgent(props.threadId, interaction.agentId);
  const identity = requestIdentity(interaction);
  const local = useLocalAnswer(interaction.id, identity);
  const earlier = useEarlierAnswer(props.threadId, interaction);
  if (interaction.request.kind !== "question") return null;
  const questions = interaction.request.questions;
  const asker = agent ? agentName(agent) : "The agent";
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
  if (!meta)
    return props.inLog ? null : (
      <WaitingLine
        asker={asker}
        title={questionTitle(questions)}
        onActivate={() => focusRequest(props.threadId, interaction.id)}
      />
    );
  return <ClosedLine asker={asker} questions={questions} resolution={resolution} meta={meta} />;
}

/** "Codex is asking · Tabs or Spaces?": the whole line brings its card up on the composer. */
function WaitingLine(props: { asker: string; title: string; onActivate(): void }) {
  return (
    <button
      type="button"
      data-transcript-row=""
      onClick={props.onActivate}
      className={cn(pressableRowClass, "text-muted-foreground")}
    >
      <span className="flex min-w-5 shrink-0 items-center justify-center text-status-needs-you">
        <Icon icon={ChatTeardropDotsIcon} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {props.asker} is asking · <span className="text-foreground">{props.title}</span>
      </span>
    </button>
  );
}

function ClosedLine(props: {
  asker: string;
  questions: readonly Question[];
  resolution: InteractionResolution | undefined;
  meta: AnsweredMeta;
}) {
  const { meta, resolution } = props;
  const [open, setOpen] = useState(false);
  const details = useId();
  const title = questionTitle(props.questions);
  const answer =
    resolution && meta.kind !== "skipped" ? answerWords(props.questions, resolution) : "";
  const outcome = outcomeWords(meta, resolution);
  return (
    <div role="group" aria-label={`Question: ${title}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={details}
        aria-label={open ? "Hide the question" : "Show the question and answer"}
        data-transcript-row=""
        onClick={() => setOpen(!open)}
        className={cn(pressableRowClass, "text-muted-foreground")}
      >
        <span className="flex min-w-5 shrink-0 items-center justify-center text-subtle-foreground">
          <Icon icon={ChatTeardropTextIcon} size={16} />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {props.asker} asked · {title}
          {answer && (
            <>
              <ArrowRightIcon
                aria-hidden
                size={12}
                className="mx-1 inline-block align-[-1px] text-subtle-foreground"
              />
              <span className="sr-only">, answered: </span>
              <span className="text-foreground">{answer}</span>
            </>
          )}
          {outcome && <span className="text-subtle-foreground"> · {outcome}</span>}
        </span>
      </button>
      {open && (
        <div id={details} className="fx-rise-in mt-2">
          <AnsweredQuestionCard
            asker={props.asker}
            questions={props.questions}
            resolution={resolution}
            meta={meta}
          />
        </div>
      )}
    </div>
  );
}
