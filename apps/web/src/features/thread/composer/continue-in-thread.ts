import type { ClientApi } from "@ace/client";
import { maxMessageBytes, type ForkPoint, type MessageContext } from "@ace/protocol";
import {
  choiceSelection,
  imageType,
  imagesUnreadable,
  providerNames,
  type ModelChoice,
} from "@ace/ui-core";
import type { Selection, ThreadSources, ThreadRef } from "../sources/index.ts";
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

/**
 * Why the new thread's model can't take one of these files, or undefined when it can take them
 * all. Only images can be refused: the model's catalog entry says which inputs it reads. Any
 * other file reaches every provider (inline, as a document or as a path), as a send's does.
 */
export function continuationAttachmentProblem(
  files: readonly { name: string; mimeType?: string | undefined }[],
  choice: Pick<ModelChoice, "provider" | "model">,
  modalities: readonly string[] | undefined,
): string | undefined {
  const images = files.filter((file) =>
    (file.mimeType ?? imageType(file.name) ?? "").startsWith("image/"),
  );
  if (!images.length) return undefined;
  const unreadable = imagesUnreadable({
    provider: providerNames[choice.provider],
    imageInput: undefined,
    model: choice.model,
    modalities,
  });
  return unreadable && `${unreadable} Remove ${images.map((file) => file.name).join(", ")} first.`;
}

/**
 * The person's message as the first one of a fork of `thread` at `point`, on `selection`: the new
 * thread reads this one's history and this thread is left as it is. Its files, mentions and thread
 * references go with it the way a send carries them, once the files have uploaded. One durable
 * command, so the message is delivered once. Resolves the new thread's id.
 */
export async function forkWithDraft(request: {
  actions: ThreadSources["actions"];
  thread: ThreadRef;
  point: ForkPoint;
  /** Undefined runs the fork on what the thread runs now. */
  selection: Selection | undefined;
  /** The provider and model label the files are checked against. */
  reads: Pick<ModelChoice, "provider" | "model">;
  /** The new thread's model's input modalities, from the catalog; undefined if unlisted. */
  modalities: readonly string[] | undefined;
  draft: Draft;
  title?: string | undefined;
}): Promise<string> {
  const { draft } = request;
  const input = draft.text.trim();
  if (!input) throw new ContinuationRefused("Write a message to start the new thread.");
  if (input.length > maxMessageBytes)
    throw new ContinuationRefused("The message is too long to start a new thread with.");
  const problem = continuationAttachmentProblem(
    draft.files.local,
    request.reads,
    request.modalities,
  );
  if (problem) throw new ContinuationRefused(problem);
  const outcomes = await draft.files.outcomes;
  if (outcomes.some((outcome) => "error" in outcome))
    throw new ContinuationRefused("A file didn't upload. Retry or remove it, then send again.");
  const hashes = new Set([
    ...draft.attachments.map((file) => file.sha256),
    ...outcomes.flatMap((outcome) => ("sha256" in outcome ? [outcome.sha256] : [])),
  ]);
  const context: MessageContext = {
    mentions: draft.mentions,
    attachments: [...hashes].map((sha256) => ({ sha256 })),
    ...(draft.threadRefs?.length ? { items: draft.threadRefs } : {}),
  };
  const opened = await request.actions.fork(request.thread, {
    point: request.point,
    input,
    selection: request.selection,
    ...(request.title ? { title: request.title } : {}),
    ...(context.mentions.length || context.attachments.length || context.items ? { context } : {}),
  });
  draft.files.release();
  return opened;
}

/**
 * The person's message as the first one of a portable fork on `choice`, from the thread's newest
 * finished turn (`forkWithDraft`). Resolves the new thread's id.
 */
export async function continueInNewThread(request: {
  client: ClientApi;
  actions: ThreadSources["actions"];
  thread: ThreadRef;
  choice: ModelChoice;
  /** The new thread's model's input modalities, from the catalog; undefined if unlisted. */
  modalities: readonly string[] | undefined;
  draft: Draft;
  busy: boolean;
}): Promise<string> {
  if (request.busy)
    throw new ContinuationRefused(
      "Wait for this turn to finish, then send again to continue in a new thread.",
    );
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
  return forkWithDraft({
    actions: request.actions,
    thread: request.thread,
    point,
    selection: choiceSelection(request.choice),
    reads: request.choice,
    modalities: request.modalities,
    draft: request.draft,
    title: request.thread.title,
  });
}
