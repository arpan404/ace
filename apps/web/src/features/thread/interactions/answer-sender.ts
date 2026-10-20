import type { ClientApi } from "@ace/client";
import { useClient, useIntentSender } from "@ace/client-react";
import type { CommandPayload, Interaction, InteractionResolution, Question } from "@ace/protocol";
import { withoutSecrets } from "@ace/ui-core";
import { refusalMessage } from "@/lib/daemon-command.ts";
import type { Answer } from "./answer.ts";
import { answerStore, pendingAnswers } from "./answers.ts";
import { questionDrafts } from "./question-drafts.ts";

const failures: Record<string, string> = {
  already_resolved: "Already answered on another device.",
  not_found: "This request no longer exists.",
  permission_mode_requires_one_shot: "This mode allows approving one action at a time only.",
  read_only_mutation_denied: "Read only mode can't approve a change.",
};

/**
 * Follow an answer's receipt to the end, whether or not its card is still on screen (the deck
 * drops a card as soon as its request closes, which can be before the receipt): remembered
 * once the daemon accepts it (its card's draft dropped), offered again once it refuses it.
 */
function settleAnswer(
  client: ClientApi,
  commandId: string,
  interactionId: string,
  identity: string | undefined,
) {
  const receipt = client.intent(commandId);
  const settled = () => {
    const state = receipt.getSnapshot()?.state;
    if (state !== "acked" && state !== "failed") return false;
    const pick = pendingAnswers.get(interactionId);
    if (state === "acked") {
      if (pick) answerStore.remember(interactionId, pick, identity);
      questionDrafts.clear(interactionId);
    }
    pendingAnswers.clear(interactionId);
    return true;
  };
  const stop = receipt.subscribe(() => {
    if (settled()) stop();
  });
  if (settled()) stop();
}

/** What answering one request needs to know of it. */
export interface AnswerTarget {
  interactionId: string;
  /** The request it answers (`requestIdentity`): an answer only counts for the same request. */
  identity: string | undefined;
  /** Its questions, so a secret answer is kept on this device only as dots. */
  questions: readonly Question[];
}

/**
 * Send one answer as a durable intent. The pick shows at once (IR-2, SY-9), a secret in it
 * masked; it is remembered once the daemon accepts it, and offered again if the daemon refuses
 * it. A second answer while one is on its way is dropped.
 */
export function sendAnswer(
  client: ClientApi,
  send: (payload: CommandPayload) => Promise<string>,
  target: AnswerTarget,
  resolution: InteractionResolution,
): boolean {
  const { interactionId } = target;
  if (pendingAnswers.get(interactionId)) return false;
  pendingAnswers.set(interactionId, withoutSecrets(target.questions, resolution));
  void send({
    type: "interaction.resolve",
    interactionId: interactionId as Interaction["id"],
    resolution,
  }).then(
    (commandId) => settleAnswer(client, commandId, interactionId, target.identity),
    () => pendingAnswers.clear(interactionId),
  );
  return true;
}

/** Answer one request from its card, with what went wrong if the daemon refused it. */
export function useAnswerSender(target: AnswerTarget) {
  const client = useClient();
  const { send, intent, error } = useIntentSender();
  const state = intent?.state;
  const answer: Answer = (resolution) => void sendAnswer(client, send, target, resolution);
  const failed =
    state === "failed"
      ? (failures[intent?.error ?? ""] ?? refusalMessage(intent?.error ?? "unknown"))
      : error
        ? "Couldn't send the answer. Check the connection and try again."
        : undefined;
  return { answer, failed };
}
