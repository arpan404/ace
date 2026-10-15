import type { ClientApi } from "@ace/client";
import { choiceSelection, type ModelChoice } from "@ace/ui-core";
import type { ThreadSources, ThreadRef } from "../sources/index.ts";
import { latestFinishedTurn } from "../transitions/fork-point.ts";
import type { Draft } from "./draft.ts";

/**
 * A model the person picked that this thread can't move to in place (`threadSwitchRoute` said
 * `new_thread`): their next message starts a new thread on it, carrying this one's context.
 */
export interface Continuation {
  threadId: string;
  choice: ModelChoice;
}

/** What the chip says while a continuation waits for the person's message. */
export const continuationNote = "Continues in a new thread with your next message";

/** Why the message can't start the new thread yet, in words the composer shows as they are. */
export class ContinuationRefused extends Error {
  override name = "ContinuationRefused";
}

/** A fork's first message is text, at most this long. */
const maxInput = 16384;

/**
 * The person's message as the first one of a portable fork on `choice`, from the thread's newest
 * finished turn: the new thread reads this one's history and this thread is left as it is. One
 * durable command, so the message is delivered once. Resolves the new thread's id.
 */
export async function continueInNewThread(request: {
  client: ClientApi;
  actions: ThreadSources["actions"];
  thread: ThreadRef;
  choice: ModelChoice;
  draft: Draft;
  busy: boolean;
}): Promise<string> {
  const { draft } = request;
  if (request.busy)
    throw new ContinuationRefused(
      "Wait for this turn to finish, then send again to continue in a new thread.",
    );
  if (draft.files.local.length || draft.attachments.length || draft.threadRefs?.length)
    throw new ContinuationRefused(
      "Attachments can't carry over to a new thread. Remove them and send, then attach them there.",
    );
  const input = draft.text.trim();
  if (!input) throw new ContinuationRefused("Write a message to start the new thread.");
  if (input.length > maxInput)
    throw new ContinuationRefused("The message is too long to start a new thread with.");
  const lease = request.client.thread(request.thread.id);
  const point = (() => {
    try {
      return latestFinishedTurn(lease.store, lease.store.thread?.rootAgentId);
    } finally {
      lease.release();
    }
  })();
  if (!point)
    throw new ContinuationRefused(
      "This thread has no finished turn to carry over. Start a new thread instead.",
    );
  return request.actions.fork(request.thread, {
    point,
    input,
    selection: choiceSelection(request.choice),
    title: request.thread.title,
  });
}
