import type { ClientApi } from "@ace/client";
import { useClient, useIntentSender } from "@ace/client-react";
import type {
  CommandPayload,
  InteractionRequest,
  InteractionResolution,
  Question,
} from "@ace/protocol";
import { withoutSecrets } from "@ace/ui-core";
import { affirms } from "@ace/projection/interaction-summary";
import { refusalMessage } from "@/lib/daemon-command.ts";
import { useThreadFreshness } from "@/lib/live-connection.ts";
import { answerRequest } from "@/lib/live-actions.ts";
import type { Answer } from "./answer.ts";
import { answerStore, pendingAnswers } from "./answers.ts";
import { questionDrafts } from "./question-drafts.ts";

const failures: Record<string, string> = {
  // Also what the daemon answers for a request withdrawn or replaced while this one was away.
  already_resolved: "Already answered or closed.",
  interaction_expired: "This request expired before your answer arrived.",
  not_found: "This request no longer exists.",
  request_not_read: "The request changed or hadn't loaded in full. Check it again, then answer.",
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
  /** The thread whose request it answers: its copy must be current as the answer goes. */
  threadId: string;
  interactionId: string;
  /** The request it answers (`requestIdentity`): an answer only counts for the same request. */
  identity: string | undefined;
  /** Its questions, so a secret answer is kept on this device only as dots. */
  questions: readonly Question[];
  /**
   * The summary, when its thread sent the request summarized (`truncated`, ADR 0157) and it
   * hasn't been read whole here: only a decline goes then.
   */
  unread?: InteractionRequest | undefined;
  /** The `version` of the request read whole and shown: a yes to it names it (`readWhole`). */
  readWhole?: string | undefined;
}

/**
 * Send one answer as a durable intent, through the one gated sender (`answerRequest`): while the
 * thread's copy isn't current it sends nothing (`stale`). The pick shows at once (IR-2, SY-9), a
 * secret in it masked; it is remembered once the daemon accepts it, and offered again if the
 * daemon refuses it. A second answer while one is on its way is dropped (`busy`), and so is a
 * yes to a request not yet read whole (`unread`).
 */
export function sendAnswer(
  client: ClientApi,
  send: (payload: CommandPayload) => Promise<string>,
  target: AnswerTarget,
  resolution: InteractionResolution,
): "sent" | "busy" | "stale" | "unread" {
  const { interactionId } = target;
  if (target.unread && affirms(target.unread, resolution)) return "unread";
  if (pendingAnswers.get(interactionId)) return "busy";
  const live = answerRequest(
    client,
    target.threadId,
    interactionId,
    resolution,
    send,
    target.readWhole,
  );
  if (!live.ok) return "stale";
  pendingAnswers.set(interactionId, withoutSecrets(target.questions, resolution));
  void live.sent.then(
    (commandId) => settleAnswer(client, commandId, interactionId, target.identity),
    () => pendingAnswers.clear(interactionId),
  );
  return "sent";
}

/**
 * Answer one request of `threadId`'s, with what went wrong if the daemon refused it. Every
 * control that answers goes through it: while the thread's copy isn't confirmed (`held`) an
 * answer sends nothing, since the request may have been answered, withdrawn or replaced.
 */
export function useAnswerSender(target: AnswerTarget) {
  const client = useClient();
  // For disabling and wording only: the send itself checks as it goes.
  const live = useThreadFreshness(target.threadId);
  const { send, intent, error } = useIntentSender();
  const state = intent?.state;
  const answer: Answer = (resolution) => void sendAnswer(client, send, target, resolution);
  const failed =
    state === "failed"
      ? (failures[intent?.error ?? ""] ?? refusalMessage(intent?.error ?? "unknown"))
      : error
        ? "Couldn't send the answer. Check the connection and try again."
        : undefined;
  /** The daemon's code for a refused answer, when it refused one. */
  const refused = state === "failed" ? intent?.error : undefined;
  return { answer, failed, refused, held: !live.fresh };
}
