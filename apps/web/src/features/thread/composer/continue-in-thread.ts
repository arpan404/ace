import type { ClientApi } from "@ace/client";
import type { ForkPoint, MessageContext } from "@ace/protocol";
import {
  choiceSelection,
  continuationAttachmentProblem,
  continuationPlan,
  forkInput,
  turnStillRunningMessage,
  type ModelChoice,
} from "@ace/ui-core";
import type { Selection, ThreadSources, ThreadRef } from "../sources/index.ts";
import type { Draft } from "./draft.ts";

/**
 * A model the person picked that this thread can't move to in place (`threadSwitchRoute` said
 * `new_thread`): their next message starts a new thread on it, carrying this one's context.
 */
export interface Continuation {
  threadId: string;
  choice: ModelChoice;
}

/** Why the message can't start the new thread yet, in words the composer shows as they are. */
export class ContinuationRefused extends Error {
  override name = "ContinuationRefused";
}

/**
 * The main agent is still mid-turn, so there is no finished turn yet to carry this message's
 * context. The composer offers to stop it; once stopped, the next send continues.
 */
export class TurnStillRunning extends ContinuationRefused {
  override name = "TurnStillRunning";
  constructor() {
    super(turnStillRunningMessage);
  }
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
  const checked = forkInput(draft.text);
  if ("refused" in checked) throw new ContinuationRefused(checked.refused);
  const { input } = checked;
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
 * finished turn (`forkWithDraft`). Only the main agent's own running turn holds it back: a usage
 * limit, background commands and subagents (running or failed) stay with this thread and never
 * block the person from carrying on elsewhere. Resolves the new thread's id.
 */
export async function continueInNewThread(request: {
  client: ClientApi;
  actions: ThreadSources["actions"];
  thread: ThreadRef;
  choice: ModelChoice;
  /** The new thread's model's input modalities, from the catalog; undefined if unlisted. */
  modalities: readonly string[] | undefined;
  draft: Draft;
}): Promise<string> {
  const lease = request.client.thread(request.thread.id);
  const plan = (() => {
    try {
      return continuationPlan(lease.store, request.draft.text);
    } finally {
      lease.release();
    }
  })();
  if (!plan.ok) throw plan.running ? new TurnStillRunning() : new ContinuationRefused(plan.message);
  const { point } = plan;
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
