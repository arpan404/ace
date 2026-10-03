import { useIntentSender } from "@ace/client-react";
import { InteractionId, type InteractionResolution } from "@ace/protocol";
import { useToast } from "@/components/ui/toast.tsx";

const failures: Record<string, string> = {
  already_resolved: "Already answered on another device.",
  not_found: "This request no longer exists.",
};

/**
 * Answer one interaction with a durable intent. The card leaves the inbox when the daemon's
 * interaction.closed arrives, not when the button is pressed; a toast confirms the send.
 */
export function useAnswer(interactionId: string) {
  const { send, intent, error } = useIntentSender();
  const toast = useToast();
  const answer = (resolution: InteractionResolution, confirmation: string) =>
    void send({
      type: "interaction.resolve",
      interactionId: InteractionId.parse(interactionId),
      resolution,
    }).then(
      () => void toast.add({ title: confirmation }),
      () => {},
    );
  const failure =
    intent?.state === "failed"
      ? (failures[intent.error ?? ""] ??
        `The daemon rejected the answer (${intent.error ?? "unknown"}).`)
      : error
        ? "Couldn't send the answer."
        : undefined;
  return { answer, sending: intent?.state === "pending", failure };
}

export const confirmations = {
  approved: "Approved · the agent continues",
  denied: "Denied · the agent will ask what to do instead",
  answered: "Answered · the agent continues",
  planApproved: "Plan approved · the agent starts",
  planRejected: "Changes requested · the agent revises the plan",
};
