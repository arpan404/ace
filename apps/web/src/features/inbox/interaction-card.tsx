import { useInteraction, useIntentSender } from "@ace/client-react";
import type { InteractionResolution } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

const failures: Record<string, string> = {
  already_resolved: "Already answered on another device.",
  not_found: "This request no longer exists.",
};

/**
 * One open interaction. Answering sends a durable intent; the card leaves the inbox when the
 * daemon's interaction.closed event arrives, not when the button is pressed.
 */
export function InteractionCard(props: { threadId: string; interactionId: string }) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  const { send, intent, error } = useIntentSender();
  if (!interaction) return null;
  const answer = (resolution: InteractionResolution) =>
    void send({ type: "interaction.resolve", interactionId: interaction.id, resolution }).catch(
      () => {},
    );
  const sending = intent?.state === "pending";
  const failed =
    intent?.state === "failed"
      ? (failures[intent.error ?? ""] ??
        `The daemon rejected the answer (${intent.error ?? "unknown"}).`)
      : error
        ? "Couldn't send the answer."
        : undefined;
  const request = interaction.request;
  const title =
    request.kind === "approval"
      ? request.title
      : request.kind === "plan_review"
        ? (request.title ?? "Review plan")
        : request.kind === "question"
          ? (request.questions[0]?.text ?? "Question")
          : request.message;
  return (
    <article
      aria-label={title}
      className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{title}</h3>
        {request.kind === "approval" && request.description && (
          <p className="text-sm text-muted-foreground">{request.description}</p>
        )}
      </div>
      {request.kind === "approval" ? (
        <div className="flex flex-wrap gap-2">
          {request.options.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={
                option.kind.startsWith("deny") || option.kind === "cancel" ? "outline" : "default"
              }
              disabled={sending}
              onClick={() => answer({ kind: "approval", optionId: option.id })}
            >
              {option.label}
            </Button>
          ))}
          {sending && (
            <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
              <Spinner /> Sending…
            </span>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Open the thread to answer this {request.kind.replace("_", " ")}.
        </p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-status-failed">
          {failed}
        </p>
      )}
    </article>
  );
}
