import { refusalMessage } from "@/lib/daemon-command.ts";
import type { ClientApi } from "@ace/client";
import { useClient, useIntentSender } from "@ace/client-react";
import { InteractionId, type InteractionResolution } from "@ace/protocol";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";

const failures: Record<string, string> = {
  already_resolved: "Already answered on another device.",
  not_found: "This request no longer exists.",
  permission_mode_requires_one_shot: "This mode allows approving one action at a time only.",
  read_only_mutation_denied: "Read only mode can't approve a change.",
};

/**
 * Answer one interaction with a durable intent (SY-9). From the click until the card leaves
 * (the daemon's interaction.closed), the answer is `sending` and `chosen` holds the pick, so
 * the card can read "✓ Allow once · sending…" and no second click can race it. The toast
 * confirms only once the daemon accepted the answer, never on a local save while offline.
 */
export function useAnswer(interactionId: string) {
  const { send, intent, error } = useIntentSender();
  const toast = useToast();
  const client = useClient();
  const [chosen, setChosen] = useState<InteractionResolution>();
  const state = intent?.state;
  const answer = (resolution: InteractionResolution, confirmation: string) => {
    setChosen(resolution);
    void send({
      type: "interaction.resolve",
      interactionId: InteractionId.parse(interactionId),
      resolution,
    }).then(
      (id) => whenAccepted(client, id, () => void toast.add({ title: confirmation })),
      () => {},
    );
  };
  const failure =
    state === "failed"
      ? (failures[intent?.error ?? ""] ?? refusalMessage(intent?.error ?? "unknown"))
      : error
        ? "Couldn't send the answer."
        : undefined;
  // Accepted is not closed: the card stays busy until the interaction closes and it goes. A
  // refused answer gives the choice back.
  const pick = failure ? undefined : chosen;
  return { answer, sending: !!pick, chosen: pick, failure };
}

/**
 * Runs `then` once the daemon accepts intent `id`. Follows the intent itself rather than the
 * card, which goes away as soon as the interaction closes, often before the receipt is read.
 */
function whenAccepted(client: ClientApi, id: string, then: () => void) {
  const selection = client.intent(id);
  let stop: (() => void) | undefined;
  const check = () => {
    const state = selection.getSnapshot()?.state;
    if (state === undefined || state === "pending") return false;
    stop?.();
    if (state === "acked") then();
    return true;
  };
  if (!check()) stop = selection.subscribe(() => void check());
}

export const confirmations = {
  approved: "Approved · the agent continues",
  denied: "Denied · the agent will ask what to do instead",
  answered: "Answered · the agent continues",
  planApproved: "Plan approved · the agent starts",
  planRejected: "Changes requested · the agent revises the plan",
};
