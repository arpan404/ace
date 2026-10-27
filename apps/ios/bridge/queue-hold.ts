import type { ThreadSource } from "@ace/client";
import type { QueuePage, QueuedMessage } from "@ace/protocol";
import {
  describeProviderError,
  heldTurn,
  heldTurnSentence,
  holdsTurn,
  providerNames,
  queueNotice,
  queuePauseControl,
  retainedInputNotice,
  shortReason,
  type QueueAction,
} from "@ace/ui-core";
import { preview } from "./presentation.ts";
import { queuedFiles } from "./take-back.ts";

/*
 * What holds the thread's queue, as the phone draws it (the web's held-turn strip, queue notice
 * and held send, by the same shared rules):
 * - `strip`: the one sentence above the composer and its ways on, as words. A usage or rate limit
 *   ("Codex is out of usage until 1:14 AM · Switch · Resume at reset · Continue"), a stopped turn
 *   (Continue), a paused queue (Resume), a model that went away (Pick another model).
 * - `notSent`: the message a failed send left at the head of the queue, which the transcript shows
 *   where it was written with Try again, Edit, Remove and Details. It is not queued work, so the
 *   queue's list leaves it out.
 * - `control`: the queue's own Pause or Resume, beside its messages.
 * Pure: the caller passes the reader, the page and the clock.
 */

export interface StripAction {
  /** A `QueueAction` id, or `choose_model` (the phone's model sheet) or `queue` (its queue sheet). */
  id: string;
  label: string;
  instanceId?: string;
  primary: boolean;
}

export interface HoldStrip {
  kind: string;
  sentence: string;
  /** A second, muted line where the hold needs one (a delivery that may have gone already). */
  detail: string;
  actions: StripAction[];
}

export interface NotSentRow {
  id: string;
  text: string;
  attachments: number;
  /** One short sentence ("Not sent · …"); empty when the daemon gave none. */
  reason: string;
  /** The rest behind Details; empty when there is nothing more to say. */
  detail: string;
}

export interface QueueHoldView {
  strip: HoldStrip | null;
  notSent: NotSentRow | null;
  control: { id: string; label: string } | null;
  /** The not-sent head's id, which the queue's list leaves out. */
  head: string | undefined;
}

export const textOf = (message: Pick<QueuedMessage, "input">) =>
  message.input
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const action = (entry: QueueAction, primary: boolean): StripAction => ({
  id: entry.id,
  label: entry.label,
  ...("instanceId" in entry && entry.instanceId ? { instanceId: entry.instanceId } : {}),
  primary,
});

export function queueHold(
  store: Pick<ThreadSource, "thread" | "queue" | "agent" | "order" | "item">,
  page: QueuePage | undefined,
  now: number,
): QueueHoldView {
  const thread = store.thread;
  const live = store.queue ?? page;
  const hold = live && {
    ...live,
    pendingCount: live.pendingCount ?? page?.total ?? page?.messages.length ?? 0,
  };
  const notice = queueNotice(thread?.status, hold, now);
  const root = thread?.rootAgentId ? store.agent(thread.rootAgentId) : undefined;
  const failure = root?.status.state === "failed" ? root.status.error : undefined;
  const running = thread?.status.state === "working";
  const view =
    failure && !running
      ? describeProviderError({
          text: failure.message,
          code: failure.code,
          kind: failure.kind,
          title: failure.title,
          provider: thread?.provider,
        })
      : undefined;
  const who = thread?.provider ? providerNames[thread.provider] : "The provider";
  const turn = heldTurn(notice, view, who, now);
  const headMessage = notice?.kind === "not_sent" ? page?.messages[0] : undefined;
  const waiting = Math.max(0, (page?.messages.length ?? 0) - (headMessage ? 1 : 0));
  const control = queuePauseControl(live, waiting);
  return {
    strip: turn
      ? {
          kind: "limit",
          sentence: heldTurnSentence(turn),
          detail: "",
          actions: [
            { id: "choose_model", label: "Switch", primary: false },
            ...(turn.atReset ? [action(turn.atReset, false)] : []),
            action(turn.carryOn, true),
          ],
        }
      : notice && notice.kind !== "not_sent" && !holdsTurn(notice)
        ? {
            kind: notice.kind,
            sentence: preview(notice.title, 256),
            detail: notice.kind === "uncertain" ? notice.detail : "",
            actions:
              notice.kind === "uncertain"
                ? [{ id: "queue", label: "Review", primary: true }]
                : notice.actions.map((entry, index) => action(entry, index === 0)),
          }
        : null,
    notSent: headMessage ? notSentRow(store, headMessage, live?.lastFailure?.title) : null,
    control: control ? { id: control.id, label: control.label } : null,
    head: headMessage?.id,
  };
}

function notSentRow(
  store: Pick<ThreadSource, "order" | "item">,
  message: QueuedMessage,
  failure: string | undefined,
): NotSentRow {
  const reason = shortReason(failure) ?? "";
  const detail = retainedInputNotice(store, message.id)?.detail?.trim() ?? "";
  return {
    id: message.id,
    text: preview(textOf(message), 8192),
    attachments: queuedFiles(message),
    reason: preview(reason, 256),
    // Details repeats nothing the line already says.
    detail: detail && detail !== failure?.trim() ? preview(detail, 2048) : "",
  };
}
