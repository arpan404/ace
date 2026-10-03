import { useAgent, useInteraction, useIntentSender, useItem } from "@ace/client-react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Prose } from "../markdown/prose.tsx";
import { agentName } from "../items/agent-row.tsx";
import { QuestionForm } from "./question-form.tsx";
import { PlanReview } from "./plan-review.tsx";
import type { Answer } from "./answer.ts";

const failures: Record<string, string> = {
  already_resolved: "Already answered on another device.",
  not_found: "This request no longer exists.",
};

/**
 * A request from an agent, answered in place: approve or deny a command, answer questions,
 * review a plan. The answer is a durable intent; the card goes away when the daemon reports
 * the interaction closed.
 */
export function InteractionCard(props: { threadId: string; interactionId: string }) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  const agent = useAgent(props.threadId, interaction?.agentId ?? "");
  const call = useItem(props.threadId, interaction?.toolCallId ?? "");
  const { send, intent, error } = useIntentSender();
  if (!interaction || interaction.state !== "pending") return null;
  const answer: Answer = (resolution) =>
    void send({ type: "interaction.resolve", interactionId: interaction.id, resolution }).catch(
      () => {},
    );
  const sending = intent?.state === "pending" || intent?.state === "acked";
  const failed =
    intent?.state === "failed"
      ? (failures[intent.error ?? ""] ??
        `The daemon rejected the answer (${intent.error ?? "unknown"}).`)
      : error
        ? "Couldn't send the answer. Check the connection and try again."
        : undefined;
  const request = interaction.request;
  const command =
    call?.type === "tool_call" && call.call.detail.kind === "shell"
      ? call.call.detail.command
      : undefined;
  const title =
    request.kind === "approval"
      ? request.title
      : request.kind === "question"
        ? request.questions.length === 1
          ? (request.questions[0]?.text ?? "Question")
          : `${request.questions.length} questions`
        : request.kind === "plan_review"
          ? (request.title ?? "Review the plan")
          : request.message;
  const kind = {
    approval: "Approval",
    question: "Question",
    plan_review: "Plan review",
    elicitation: request.kind === "elicitation" ? request.server : "Request",
  }[request.kind];
  return (
    <article
      aria-label={title}
      className="rounded-lg px-[18px] py-4 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <p className="flex items-center gap-[7px] text-xs text-subtle-foreground">
        <Dot tone="needs-you" />
        {agent ? agentName(agent) : "Agent"} · {kind}
      </p>
      {request.kind !== "question" || request.questions.length !== 1 ? (
        <h3 className="mt-2 mb-2.5 text-md leading-[1.35] font-medium tracking-[-0.005em]">
          {title}
        </h3>
      ) : null}
      {command && (
        <pre className="rounded-[9px] bg-code px-3 py-[9px] font-mono text-[12.5px] leading-[1.5] whitespace-pre-wrap">
          {command}
        </pre>
      )}
      {request.kind === "approval" && (
        <>
          {request.description && (
            <p className="mt-2.5 text-ui text-muted-foreground">{request.description}</p>
          )}
          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            {request.options.map((option, index) => {
              const refuse = option.kind.startsWith("deny") || option.kind === "cancel";
              return (
                <Button
                  key={option.id}
                  size="sm"
                  variant={refuse ? "ghost" : index === 0 ? "primary" : "secondary"}
                  disabled={sending}
                  onClick={() => answer({ kind: "approval", optionId: option.id })}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        </>
      )}
      {request.kind === "question" && (
        <QuestionForm questions={request.questions} disabled={sending} onAnswer={answer} />
      )}
      {request.kind === "plan_review" && (
        <PlanReview disabled={sending} onAnswer={answer}>
          <Prose text={request.markdown} className="text-ui leading-[1.55]" />
        </PlanReview>
      )}
      {request.kind === "elicitation" && (
        <div className="mt-3.5 flex gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={sending}
            onClick={() => answer({ kind: "elicitation", action: "accept" })}
          >
            Continue
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={sending}
            onClick={() => answer({ kind: "elicitation", action: "decline" })}
          >
            Decline
          </Button>
        </div>
      )}
      {sending && !failed && (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner /> Sending your answer…
        </p>
      )}
      {failed && (
        <p role="alert" className="mt-2 text-sm text-status-failed">
          {failed}
        </p>
      )}
    </article>
  );
}
