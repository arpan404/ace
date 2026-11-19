import { z } from "zod";
import type { ClientCore } from "@ace/client";
import {
  InteractionId,
  ThreadId,
  type Agent,
  type CommandPayload,
  type EntitiesPage,
  type Interaction,
  type Item,
  type ThreadListEntry,
} from "@ace/protocol";
import { messageText } from "@ace/ui-core";
import type { PatchSink } from "./agents.ts";
import { dispatchCommand } from "./commands.ts";
import { interactionRow } from "./interaction-rows.ts";
import { preview } from "./presentation.ts";
import { answerResolution } from "./thread-controls.ts";
import { phoneAnswer } from "./summarized-requests.ts";
import { RequestAnswer, requestResolution } from "./thread-requests.ts";

/*
 * What each inbox row waits on the person for, read without opening the thread: for every
 * thread the daemon lists as needing the person, its pending requests as the thread's request
 * strip words them (`interactionRow`), within ADR 0074's preview bounds. Only threads the daemon
 * marks `needs_you` are read, one bounded page at a time, until every request it counts is found
 * or no older page is left (never a fixed number of pages: large answered requests in front of
 * a pending one must not hide it; daemons since 2026-11 send pending requests first). A request
 * too large for the daemon to send is counted and shown as one to open on a computer.
 *
 * Guarantee: every request pending both when a read starts and when it ends is shown, within
 * `readsMost` pages. One opened during a read changes the thread's count, and that change reads
 * again. The total is the daemon's count, never the number read. It counts the thread's whole
 * tree, so it can hold requests waiting in delegated threads that this row can't show: a read
 * that found everything says how many (`elsewhere`), and one that stopped at the cap before
 * finding them all says so (`more`, with `loaded`). A row's requests change only when the
 * daemon's read says so, never on this phone's guess. Answers re-read the request first and go
 * through the durable command path (ADR 0012), as notification actions do.
 */

/** Rows and the needs-you run show this many requests per thread; the count says the rest. */
export const shownPerThread = 8;
const pageSize = 50;
/** Pages of 64 KiB (the daemon's default is 128): every pending request is on the first anyway. */
const pageBytes = 64 * 1024;
/** Newest first: everything before the end of time. */
const newest = Number.MAX_SAFE_INTEGER;
/**
 * A bound on one read's pages, whatever a daemon answers: 200 pages (at 64 KiB, 12.5 MiB). A
 * read that stops here before finding every request the daemon counts says so (`more`).
 */
const readsMost = 200;

/** A request the daemon named but could not send, too large for any reply. */
type TooLargeRequest = NonNullable<EntitiesPage["tooLarge"]>[number];
/** What a thread waits on: requests read, then any too large to send. */
type Waiting = Interaction | TooLargeRequest;

/** A request too large to send, as a row: counted as waiting, opened on a larger screen. */
const tooLargeRow = (request: TooLargeRequest) => ({
  id: request.id,
  kind: "too_large",
  state: "pending",
  title: "A request too large to show here",
  description: "Open it on your computer to see and answer it.",
  command: "",
  options: [],
  truncated: true,
  unanswerable: true,
});
/** The agent's last words, as one muted paragraph in the run. */
const wordsLimit = 600;
const itemsRead = 24;

/**
 * When a thread's requests must be read again: the daemon's count of what waits on the person
 * and the thread's revision time. Undefined while nothing waits, which clears the row's requests.
 */
export function needsSignature(entry: ThreadListEntry | undefined): string | undefined {
  if (!entry || entry.archivedAt !== undefined || entry.status.state !== "needs_you")
    return undefined;
  return `${entry.status.interactions}:${entry.updatedAt}`;
}

/** The pending requests among a page of interactions, oldest first, as the strip pages them. */
export function pendingOf(interactions: readonly Interaction[]): Interaction[] {
  return interactions
    .filter((interaction) => interaction.state === "pending")
    .toSorted((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** The newest thing an agent said in words: the last assistant message that isn't ace's own. */
export function lastAgentWords(items: readonly Item[]): string {
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at];
    if (item?.type !== "message" || item.role !== "assistant" || item.synthetic) continue;
    const text = messageText(item).replace(/\s+/g, " ").trim();
    if (text) return preview(text, wordsLimit);
  }
  return "";
}

const boundedId = z.string().min(1).max(200);
const requestId = z.string().min(1).max(64);
const NeedsAnswer = z.union([
  z.object({ kind: z.literal("approval"), optionId: boundedId }),
  z.object({
    kind: z.literal("question"),
    answers: z.record(z.string(), z.array(z.string().max(8192)).max(64)),
    dismissed: z.boolean(),
  }),
  RequestAnswer,
]);
export type NeedsAnswer = z.infer<typeof NeedsAnswer>;

export const NeedsAction = z.discriminatedUnion("type", [
  /** Answer one request from the inbox or the needs-you run. */
  z.object({
    type: z.literal("needs.answer"),
    threadId: ThreadId.and(boundedId),
    interactionId: InteractionId.and(boundedId),
    answer: NeedsAnswer,
    requestId,
  }),
  /** The run's page for this thread opened: read what the agent last said. */
  z.object({ type: z.literal("needs.context"), threadId: ThreadId.and(boundedId) }),
]);
export type NeedsAction = z.infer<typeof NeedsAction>;

type Resolution = Extract<CommandPayload, { type: "interaction.resolve" }>["resolution"];

/** The resolution an answer makes for the request as it stands now; undefined when it doesn't fit. */
export function needsResolution(
  interaction: Interaction | undefined,
  answer: NeedsAnswer,
): Resolution | undefined {
  if (interaction?.state !== "pending") return undefined;
  switch (answer.kind) {
    case "approval": {
      if (interaction.request.kind !== "approval") return undefined;
      const option = interaction.request.options.find(
        (candidate) => candidate.id === answer.optionId,
      );
      return option
        ? phoneAnswer(interaction, { kind: "approval", optionId: option.id })
        : undefined;
    }
    case "question":
      return answerResolution(interaction, answer.answers, answer.dismissed);
    default:
      return requestResolution(interaction, answer);
  }
}

export interface NeedsFollow {
  handle(action: NeedsAction): void;
  stop(): void;
}

type Owner = Pick<
  ClientCore,
  "threads" | "request" | "connectionState" | "commandId" | "intent" | "enqueue"
>;

export function followNeeds(owner: Owner, pump: PatchSink): NeedsFollow {
  const store = owner.threads().store;
  const connection = owner.connectionState();
  /** What each thread's requests were last read against, or are being read against. */
  const read = new Map<string, string>();
  const reading = new Set<string>();
  /** Threads whose requests the phone holds, so one that stops waiting is cleared once. */
  const held = new Set<string>();

  /**
   * The thread's pending requests, and whether the read stopped before finding all the daemon
   * counts while older pages were left (`more`): at `readsMost`, or at a cursor already read.
   */
  const interactions = async (
    threadId: string,
  ): Promise<{ requests: Waiting[]; more: boolean }> => {
    // By id, the latest copy kept: one answered between two pages comes again in its new
    // state, and a daemon that read a cursor as a fresh start sends some again.
    const found = new Map<string, Interaction | TooLargeRequest>();
    const pending = () =>
      [...found.values()].filter((entry) =>
        "active" in entry ? entry.active : entry.state === "pending",
      );
    const sent = new Set<number>();
    let before = newest;
    let more = true;
    for (let page = 0; page < readsMost; page++) {
      sent.add(before);
      const reply = await owner.request({
        type: "entities.page",
        threadId,
        collection: "interactions",
        before,
        limit: pageSize,
        maxBytes: pageBytes,
      });
      const { page: result } = reply;
      if (result.collection !== "interactions") break;
      for (const entry of result.entries) found.set(entry.id, entry);
      for (const entry of result.tooLarge ?? []) found.set(entry.id, entry);
      const want = needsSignature(store.thread(threadId)) ? waitingCount(threadId) : 0;
      if (pending().length >= want || result.entitiesBefore === null) {
        // Every one counted, or nothing older: all there is to read was read.
        more = false;
        break;
      }
      // A cursor already read would read the same pages again.
      if (sent.has(result.entitiesBefore)) break;
      before = result.entitiesBefore;
    }
    const all = pending();
    const requests = [
      ...pendingOf(all.filter((entry): entry is Interaction => !("active" in entry))),
      ...all.filter((entry): entry is TooLargeRequest => "active" in entry),
    ];
    return { requests, more: more && requests.length < waitingCount(threadId) };
  };
  const waitingCount = (threadId: string) => {
    const status = store.thread(threadId)?.status;
    return status?.state === "needs_you" ? status.interactions : 0;
  };
  const agents = async (threadId: string) => {
    const reply = await owner.request({
      type: "entities.page",
      threadId,
      collection: "agents",
      before: newest,
      limit: pageSize,
      maxBytes: pageBytes,
    });
    const byId = new Map<string, Agent>();
    if (reply.page.collection === "agents")
      for (const agent of reply.page.entries) byId.set(agent.id, agent);
    return byId;
  };

  const put = (
    threadId: string,
    { requests, more }: { requests: readonly Waiting[]; more: boolean },
    byId: Map<string, Agent>,
  ) => {
    const entry = store.thread(threadId);
    const reader = {
      item: () => undefined,
      agent: (id: string) => byId.get(id),
      thread: entry ? { provider: entry.provider } : undefined,
    };
    held.add(threadId);
    pump.put(`needs:${threadId}`, () => ({
      type: "inbox.needs",
      id: threadId,
      // What the daemon counts as waiting in the thread's tree, never fewer than were read.
      total: Math.max(waitingCount(threadId), requests.length),
      // How many were read, and whether the read stopped before finding them all.
      loaded: requests.length,
      more,
      // After a read that found all this thread holds: what waits in its delegated threads.
      elsewhere: more ? 0 : Math.max(0, waitingCount(threadId) - requests.length),
      requests: requests
        .slice(0, shownPerThread)
        .map((interaction) =>
          "active" in interaction
            ? tooLargeRow(interaction)
            : interactionRow(
                interaction,
                reader,
                interaction.request.kind === "approval"
                  ? (interaction.request.target?.command ?? "")
                  : "",
              ),
        ),
    }));
  };
  const clear = (threadId: string) => {
    read.delete(threadId);
    if (!held.delete(threadId)) return;
    pump.put(`needs:${threadId}`, () => ({
      type: "inbox.needs",
      id: threadId,
      total: 0,
      loaded: 0,
      more: false,
      elsewhere: 0,
      requests: [],
    }));
  };

  const refresh = async (threadId: string) => {
    if (reading.has(threadId)) return;
    const signature = needsSignature(store.thread(threadId));
    if (signature === undefined) return clear(threadId);
    reading.add(threadId);
    read.set(threadId, signature);
    try {
      const [pending, byId] = await Promise.all([interactions(threadId), agents(threadId)]);
      // Still waiting on the person by the daemon's latest list: show what the read found.
      if (needsSignature(store.thread(threadId)) !== undefined) put(threadId, pending, byId);
    } catch {
      // Offline or refused: keep what the row shows; the next list change or connection reads again.
      read.delete(threadId);
    } finally {
      reading.delete(threadId);
    }
    if (read.get(threadId) !== needsSignature(store.thread(threadId))) void refresh(threadId);
  };
  const check = (threadId: string) => {
    const signature = needsSignature(store.thread(threadId));
    if (signature === undefined) clear(threadId);
    else if (read.get(threadId) !== signature && connection.getSnapshot() === "ready")
      void refresh(threadId);
  };
  const checkAll = () => {
    const ids = new Set(store.ids);
    for (const id of held) if (!ids.has(id)) clear(id);
    for (const id of ids) check(id);
  };

  const stops = [
    store.observe((changed) => {
      if (changed === "all" || changed.has("ids")) return checkAll();
      for (const key of changed) if (key.startsWith("thread:")) check(key.slice(7));
    }),
    connection.subscribe(() => {
      if (connection.getSnapshot() !== "ready") return;
      // What waited may have been answered elsewhere while this phone was away.
      read.clear();
      checkAll();
    }),
  ];
  checkAll();

  const answer = async (action: Extract<NeedsAction, { type: "needs.answer" }>) => {
    let resolution: Resolution | undefined;
    try {
      const { requests: pending } = await interactions(action.threadId);
      resolution = needsResolution(
        // A request too large to send is never answered here: it has nothing to answer with.
        pending.find(
          (interaction): interaction is Interaction =>
            !("active" in interaction) && interaction.id === action.interactionId,
        ),
        action.answer,
      );
    } catch {
      resolution = undefined;
    }
    if (!resolution) {
      // Answered elsewhere, or no longer offered: give the controls back without words, and
      // read the thread again so the row shows what waits now.
      pump.put(`admission:${action.requestId}`, () => ({
        type: "admission",
        id: action.requestId,
        ok: false,
        message: "",
      }));
      read.delete(action.threadId);
      check(action.threadId);
      return;
    }
    await dispatchCommand(
      owner,
      { type: "interaction.resolve", interactionId: action.interactionId, resolution },
      action.requestId,
      pump,
      {
        receipt: () => {
          read.delete(action.threadId);
          check(action.threadId);
        },
      },
    );
  };
  const context = async (threadId: string) => {
    try {
      const reply = await owner.request({
        type: "items.page",
        threadId,
        before: newest,
        limit: itemsRead,
      });
      const words = lastAgentWords(reply.items);
      pump.put(`needs.context:${threadId}`, () => ({
        type: "inbox.needs.context",
        id: threadId,
        words,
      }));
    } catch {
      // The page shows without the agent's words.
    }
  };

  return {
    handle(action) {
      if (action.type === "needs.answer") void answer(action);
      else void context(action.threadId);
    },
    stop() {
      for (const stop of stops.splice(0)) stop();
    },
  };
}
