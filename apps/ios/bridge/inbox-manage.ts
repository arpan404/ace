import type { ClientCore } from "@ace/client";
import {
  ThreadId,
  WorkspaceId,
  type CommandPayload,
  type CommandResult,
  type ThreadListEntry,
} from "@ace/protocol";
import { deleteQuestion, isSettled, settleChoice, type OrganizePatch } from "@ace/ui-core";
import { actionErrorText } from "@ace/ui-core/mobile";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { dispatchCommand, type Receipt } from "./commands.ts";
import type { InboxOrganizer } from "./inbox-organize.ts";
import type { InboxClock } from "./inbox-rows.ts";
import { preview } from "./presentation.ts";

/*
 * The rest of the web's thread actions for the phone's inbox, by the same commands and patches as
 * the web's Home (`use-thread-actions.ts`): mark read or unread, auto-settle on or off, move to
 * another project and delete, one thread at a time or several at once. Each shows on its row at
 * once (`inbox-organize.ts`) and goes through the SDK's durable outbox.
 *
 * Delete and every action on several threads answer as a request (`inbox.bulk`): saved on this
 * device, then the daemon's answer for each thread within a few seconds, so the phone can say
 * which it refused and offer Stop and delete for those whose agents or terminals still run.
 * Offline, the answer comes once they are saved, and the rest apply on reconnect.
 */

export const ManageAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), threadId: ThreadId, unread: z.boolean() }),
  z.object({ kind: z.literal("autoSettle"), threadId: ThreadId, enabled: z.boolean() }),
  z.object({ kind: z.literal("move"), threadId: ThreadId, workspaceId: WorkspaceId }),
]);
export type ManageAction = z.infer<typeof ManageAction>;

const BulkKind = z.enum([
  "pin",
  "unpin",
  "settle",
  "unsettle",
  "archive",
  "unarchive",
  "read",
  "unread",
  "move",
  "delete",
]);
export type BulkKind = z.infer<typeof BulkKind>;

export const InboxBulkRequest = z.object({
  type: z.literal("inbox.bulk"),
  action: BulkKind,
  threadIds: z.array(ThreadId).min(1).max(500),
  /** The project a move goes to. */
  workspaceId: WorkspaceId.optional(),
  /** Delete: stop running agents and terminals first (`thread.delete` `force`). */
  force: z.boolean().optional(),
});
export type InboxBulkRequest = z.infer<typeof InboxBulkRequest>;

export const InboxDeleteQuestionRequest = z.object({
  type: z.literal("inbox.deleteQuestion"),
  threadIds: z.array(ThreadId).min(1).max(500),
});

/** What the phone hears back from `inbox.bulk`. */
export interface BulkOutcome {
  /** Threads whose command this device saved. */
  saved: string[];
  /** Threads left alone: already so, or (Settle) still working. */
  skipped: string[];
  /** Threads the daemon refused, with its reason in words. */
  refused: { threadId: string; message: string }[];
  /** Threads a delete was refused for only because their work still runs: Stop and delete. */
  running: string[];
  /** Threads saved but not yet answered (offline, or the daemon is slow). */
  waiting: string[];
}

function patchOf(action: ManageAction): { patch: OrganizePatch; payload: CommandPayload } {
  switch (action.kind) {
    case "read":
      return {
        patch: { unread: action.unread },
        payload: { type: "thread.read", threadId: action.threadId, unread: action.unread },
      };
    case "autoSettle":
      return {
        patch: { autoSettle: action.enabled },
        payload: { type: "thread.autoSettle", threadId: action.threadId, enabled: action.enabled },
      };
    case "move":
      return {
        patch: { workspaceId: action.workspaceId },
        payload: {
          type: "thread.move",
          threadId: action.threadId,
          workspaceId: action.workspaceId,
        },
      };
  }
}

/** One thread's read, auto-settle or move: on its row now, admitted under `requestId`. */
export function runManage(
  organizer: InboxOrganizer,
  action: ManageAction,
  requestId: string,
  pump: PatchSink,
): Promise<boolean> {
  const { patch, payload } = patchOf(action);
  return organizer.run(action.threadId, patch, payload, requestId, pump);
}

/** The commands of one bulk action, per thread, or undefined to leave the thread alone. */
function bulkStep(
  request: InboxBulkRequest,
  entry: ThreadListEntry,
  order: number,
): { patch: OrganizePatch; payload: CommandPayload } | undefined {
  const threadId = ThreadId.parse(entry.id);
  switch (request.action) {
    case "pin":
      // Pinned together they lead the group in the order they were listed.
      return entry.pinned === true
        ? undefined
        : {
            patch: { pinned: true, pinOrder: order },
            payload: { type: "thread.pin", threadId, pinned: true, order },
          };
    case "unpin":
      return entry.pinned === true
        ? { patch: { pinned: false }, payload: { type: "thread.pin", threadId, pinned: false } }
        : undefined;
    case "settle":
      return settleChoice(entry, { settled: isSettled(entry) }) === "settle"
        ? { patch: { settled: true }, payload: { type: "thread.settle", threadId } }
        : undefined;
    case "unsettle":
      return isSettled(entry)
        ? {
            patch: { settled: false, autoSettle: false },
            payload: { type: "thread.unsettle", threadId },
          }
        : undefined;
    case "archive":
      return entry.archivedAt === undefined
        ? { patch: { archived: true }, payload: { type: "thread.archive", threadId } }
        : undefined;
    case "unarchive":
      return entry.archivedAt === undefined
        ? undefined
        : { patch: { archived: false }, payload: { type: "thread.unarchive", threadId } };
    case "read":
    case "unread": {
      const unread = request.action === "unread";
      return { patch: { unread }, payload: { type: "thread.read", threadId, unread } };
    }
    case "move": {
      const workspaceId = request.workspaceId;
      return workspaceId === undefined || workspaceId === entry.workspaceId
        ? undefined
        : { patch: { workspaceId }, payload: { type: "thread.move", threadId, workspaceId } };
    }
    case "delete":
      return {
        patch: { deleted: true },
        payload: { type: "thread.delete", threadId, ...(request.force ? { force: true } : {}) },
      };
  }
}

const stillAlive = (alive: CommandResult["alive"]) =>
  alive !== undefined && Object.values(alive).some((count) => count > 0);

const unarchived = (threadId: string): CommandPayload => ({
  type: "thread.unarchive",
  threadId: ThreadId.parse(threadId),
});

/** How long a bulk answer waits for the daemon after every command is saved. */
export const bulkAnswerMs = 6_000;

/**
 * Run one action on several threads of this machine (or one delete). Resolves once every
 * command is saved and the daemon answered each, or `bulkAnswerMs` after saving, whichever
 * comes first.
 */
export function runBulk(
  owner: ClientCore,
  organizer: InboxOrganizer,
  clock: InboxClock,
  request: InboxBulkRequest,
  requestId: string,
  pump: PatchSink,
): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { saved: [], skipped: [], refused: [], running: [], waiting: [] };
  const top = clock.now();
  const store = owner.threads().store;
  type Step = { threadId: string; patch: OrganizePatch | undefined; payload: CommandPayload };
  const steps = request.threadIds.flatMap((threadId, index): Step[] => {
    const entry = organizer.entry(threadId) ?? store.thread(threadId);
    // An archived thread is no longer in the list: restoring it needs only its command.
    if (!entry && request.action === "unarchive")
      return [{ threadId, patch: undefined, payload: unarchived(threadId) }];
    const step = entry && bulkStep(request, entry, top + request.threadIds.length - index);
    if (!step) outcome.skipped.push(threadId);
    return step ? [{ threadId, ...step }] : [];
  });
  if (!steps.length) return Promise.resolve(outcome);
  // A row in the list shows the change at once; anything else just sends its command.
  const send = (
    threadId: string,
    patch: OrganizePatch | undefined,
    payload: CommandPayload,
    id: string,
    heard: (result: Receipt) => void,
  ): Promise<boolean> => {
    if (patch) return organizer.run(threadId, patch, payload, id, pump, heard);
    let saved = false;
    return dispatchCommand(owner, payload, id, pump, {
      saved: () => (saved = true),
      receipt: heard,
    }).then(() => saved);
  };
  return new Promise((resolve) => {
    const answered = new Set<string>();
    let saving = steps.length;
    let finished = false;
    let cancel: (() => void) | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancel?.();
      outcome.waiting = outcome.saved.filter((id) => !answered.has(id));
      resolve(outcome);
    };
    const settle = () => {
      if (saving > 0) return;
      if (outcome.saved.every((id) => answered.has(id))) finish();
      else cancel ??= clock.set(bulkAnswerMs, finish);
    };
    steps.forEach((step, index) => {
      const id = `${requestId}.${index}`;
      void send(step.threadId, step.patch, step.payload, id, (result) => {
        answered.add(step.threadId);
        if (!result.ok) {
          if (request.action === "delete" && !request.force && stillAlive(result.alive))
            outcome.running.push(step.threadId);
          else
            outcome.refused.push({
              threadId: step.threadId,
              message: preview(actionErrorText(result.error), 512),
            });
        }
        settle();
      }).then((saved) => {
        saving -= 1;
        if (saved) outcome.saved.push(step.threadId);
        else {
          answered.add(step.threadId);
          outcome.refused.push({
            threadId: step.threadId,
            message: "Couldn't save that on this device.",
          });
        }
        settle();
      });
    });
  });
}

/** The question the phone asks before deleting `threadIds` for good, from their listed state. */
export function readDeleteQuestion(
  organizer: InboxOrganizer,
  threadIds: readonly string[],
): ReturnType<typeof deleteQuestion> {
  const threads = threadIds.flatMap((id) => {
    const entry = organizer.entry(id);
    return entry ? [{ title: preview(entry.title, 512), status: entry.status }] : [];
  });
  return deleteQuestion(threads.length ? threads : [{ title: "", status: { state: "done" } }]);
}

/** The inbox's own requests, answered by `NativeServices`; undefined for any other request. */
export type InboxRequests = (raw: unknown, requestId: string) => Promise<unknown> | undefined;

export function inboxRequests(
  owner: ClientCore,
  organizer: InboxOrganizer,
  clock: InboxClock,
  pump: PatchSink,
): InboxRequests {
  return (raw, requestId) => {
    const bulk = InboxBulkRequest.safeParse(raw);
    if (bulk.success) return runBulk(owner, organizer, clock, bulk.data, requestId, pump);
    const question = InboxDeleteQuestionRequest.safeParse(raw);
    if (question.success)
      return Promise.resolve(readDeleteQuestion(organizer, question.data.threadIds));
    return undefined;
  };
}
