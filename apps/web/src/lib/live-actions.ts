import type { ClientApi } from "@ace/client";
import {
  AgentId,
  BackgroundTaskId,
  CommandId,
  InteractionId,
  ThreadId,
  type CommandPayload,
  type ContentPart,
  type InteractionResolution,
  type MessageContext,
} from "@ace/protocol";
import { queueActionPayload, type QueueAction, type StopFence } from "@ace/ui-core";
import { CommandRefused, runCommand } from "./daemon-command.ts";
import { currentNow } from "./live-connection.ts";
import type { ListAction } from "./list-actions.ts";

/*
 * Every action on what a thread copy shows is built and sent here, and nowhere else in the web
 * app (the `ace/live-actions` lint rule holds the command names to this file): an answer, a
 * Stop, a queue change, a send-now steer, an archive, a delete. Each reads the client and its
 * store at the moment it sends (`currentNow`), never a value drawn earlier, and refuses with a
 * typed result while the copy it acts on isn't current: offline, reconnecting, catching up
 * after a reconnect, or read back from disk. UI checks of the same gate are for disabling and
 * wording only. Stops always name what they may stop.
 */

/** Why a live action was not sent. */
export type LiveRefusal =
  /** The thread's (or the list's) copy isn't current: it may say what is no longer true. */
  | "stale_copy"
  /** A Stop that could name neither a run nor a cursor: it could stop later work. */
  | "unfenced";
export type Live<T> = { ok: true; sent: Promise<T> } | { ok: false; refused: LiveRefusal };
type Send<T> = (payload: CommandPayload) => Promise<T>;

/** What a live action decides on: one thread's copy, or the thread list. */
export type Basis = { threadId: string } | "list";

const current = (client: ClientApi, basis: Basis) =>
  basis === "list" ? currentNow(client) : currentNow(client, basis.threadId);

function gated<T>(
  client: ClientApi,
  basis: Basis,
  payload: CommandPayload,
  send: Send<T>,
): Live<T> {
  if (!current(client, basis)) return { ok: false, refused: "stale_copy" };
  return { ok: true, sent: send(payload) };
}

/** `gated`, for callers that report a refusal the way the daemon's are: as `CommandRefused`. */
function refusing<T>(live: Live<T>): Promise<T> {
  return live.ok ? live.sent : Promise.reject(new CommandRefused(live.refused));
}

/** Answer one of `threadId`'s requests. The daemon also refuses a closed or replaced id. */
export function answerRequest<T>(
  client: ClientApi,
  threadId: string,
  interactionId: string,
  resolution: InteractionResolution,
  send: Send<T>,
): Live<T> {
  return gated(
    client,
    { threadId },
    {
      type: "interaction.resolve",
      interactionId: InteractionId.parse(interactionId),
      resolution,
    },
    send,
  );
}

/** Stop a thread's whole tree, naming the run (or cursor) it was pressed in. */
export function stopThread<T>(
  client: ClientApi,
  basis: Basis,
  threadId: string,
  fence: StopFence | undefined,
  send: Send<T>,
): Live<T> {
  if (!fence) return { ok: false, refused: "unfenced" };
  return gated(
    client,
    basis,
    { type: "thread.interrupt", threadId: ThreadId.parse(threadId), cascade: true, ...fence },
    send,
  );
}

/** Stop one agent and everything under it, naming its run (or the cursor). */
export function stopAgent<T>(
  client: ClientApi,
  threadId: string,
  agentId: string,
  fence: StopFence | undefined,
  send: Send<T>,
): Live<T> {
  if (!fence) return { ok: false, refused: "unfenced" };
  return gated(
    client,
    { threadId },
    {
      type: "thread.interrupt",
      threadId: ThreadId.parse(threadId),
      agentId: AgentId.parse(agentId),
      cascade: true,
      ...fence,
    },
    send,
  );
}

/** Stop one background task. The daemon also refuses one no longer running. */
export function stopTask<T>(
  client: ClientApi,
  basis: Basis,
  taskId: string,
  send: Send<T>,
): Live<T> {
  return gated(
    client,
    basis,
    { type: "background_task.stop", taskId: BackgroundTaskId.parse(taskId) },
    send,
  );
}

/** The queue revision a change was decided on: the daemon refuses it once the queue moved. */
export interface QueueTarget {
  threadId: string;
  expectedRevision: number;
}
/** One queued message changed, by its id. */
export type QueueChange =
  | { kind: "move"; messageId: string; after: string | null }
  | { kind: "remove" | "resend"; messageId: string }
  | {
      kind: "edit" | "send-now";
      messageId: string;
      input: ContentPart[];
      context?: MessageContext | undefined;
    };

function queuePayload(target: QueueTarget, change: QueueChange): CommandPayload {
  const base = {
    threadId: ThreadId.parse(target.threadId),
    expectedRevision: target.expectedRevision,
    messageId: CommandId.parse(change.messageId),
  };
  switch (change.kind) {
    case "move":
      return {
        type: "queue.move",
        ...base,
        after: change.after === null ? null : CommandId.parse(change.after),
      };
    case "remove":
      return { type: "queue.remove", ...base };
    case "resend":
      return { type: "queue.resend", ...base };
    case "edit":
    case "send-now":
      return {
        type: "queue.edit",
        ...base,
        input: change.input,
        ...(change.context ? { context: change.context } : {}),
        ...(change.kind === "send-now" ? { delivery: "steer" as const } : {}),
      };
  }
}

/** Change one queued message, at the revision it was decided on. */
export function changeQueue<T>(
  client: ClientApi,
  target: QueueTarget,
  change: QueueChange,
  send: Send<T>,
): Live<T> {
  return gated(client, { threadId: target.threadId }, queuePayload(target, change), send);
}

/** The queue as the daemon has it now: queue-wide actions decide on this, never on a copy. */
async function currentQueue(client: ClientApi, threadId: string) {
  const { queue } = await client.request({
    type: "queue.get",
    threadId: ThreadId.parse(threadId),
    limit: 1,
  });
  return queue;
}

/**
 * One queue-wide action (resume, hold, a limit choice), fenced to the revision read just before,
 * and sent only while the thread's copy is current. Rejects when refused here or by the daemon.
 */
export async function queueAction(
  client: ClientApi,
  threadId: string,
  action: QueueAction,
): Promise<void> {
  const queue = await currentQueue(client, threadId);
  const payload = queueActionPayload(action, ThreadId.parse(threadId), queue);
  if (!payload) return;
  await refusing(
    gated(client, { threadId }, payload, (sent) => runCommand(client, sent, crypto.randomUUID())),
  );
}

/** Resume a thread's queue at its current revision (after its setup was resolved). */
export async function resumeQueue(client: ClientApi, threadId: string): Promise<void> {
  const queue = await currentQueue(client, threadId);
  await refusing(
    gated(
      client,
      { threadId },
      {
        type: "queue.resume",
        threadId: ThreadId.parse(threadId),
        expectedRevision: queue.revision,
      },
      (sent) => runCommand(client, sent),
    ),
  );
}

/**
 * The newest thread event this client has seen: its loaded copy's cursor, or its list entry's
 * latest status. A command that stops the thread's work names it, and the daemon refuses it
 * (`thread_changed`) once work started after it, also when it replays from the outbox later.
 */
function decidedAt(client: ClientApi, threadId: string): number | undefined {
  const seen = Math.max(
    client.peekThread?.(threadId)?.cursor ?? -1,
    client.cachedThreads?.()?.thread(threadId)?.activitySeq ?? -1,
  );
  return seen < 0 ? undefined : seen;
}

/**
 * Send a list action, checking the list as it sends. An archive (it stops commands a thread left
 * running) or a forced delete (Stop and delete) confirmed after the list stopped being current is
 * refused (`CommandRefused` `stale_copy`), never sent as it was asked; one sent names the event
 * it was decided at (`decidedAt`), so the daemon refuses it if newer work started. A plain delete
 * goes as it is, offline too: the daemon refuses it while any work of the thread still runs.
 */
export function sendListAction<T>(
  client: ClientApi,
  action: ListAction,
  send: Send<T>,
): Promise<T> {
  const threadId = ThreadId.parse(action.threadId);
  if (action.kind === "delete" && !action.force) return send({ type: "thread.delete", threadId });
  const seen = decidedAt(client, threadId);
  const fence = seen === undefined ? {} : { beforeSeq: seen };
  const payload: CommandPayload =
    action.kind === "archive"
      ? { type: "thread.archive", threadId, ...fence }
      : { type: "thread.delete", threadId, force: true, ...fence };
  return refusing(gated(client, "list", payload, send));
}

/**
 * A message's delivery as it is sent: a steer aimed at no known run, sent while the thread's copy
 * isn't current, queues instead (nothing says what runs now). A steer naming its run keeps it:
 * the daemon queues that one itself if the run is over.
 */
export function followUpDelivery(
  client: ClientApi,
  threadId: string,
  delivery: "steer" | "queue" | undefined,
  runId: string | undefined,
): "steer" | "queue" | undefined {
  return delivery === "steer" && runId === undefined && !currentNow(client, threadId)
    ? "queue"
    : delivery;
}
