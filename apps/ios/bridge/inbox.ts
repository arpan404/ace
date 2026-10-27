import type { ChangeTap, ClientCore, PendingSend, SidebarSource } from "@ace/client";
import { settledTotal, type HomeSort } from "@ace/ui-core";
import {
  inboxNextChange,
  snoozePresets,
  unsentStatus,
  unsentText,
  type InboxThread,
} from "@ace/ui-core/mobile";
import { ThreadId, type CommandPayload } from "@ace/protocol";
import { z } from "zod";
import { host } from "./host.ts";
import { preview } from "./presentation.ts";
import { followAccounts } from "./inbox-accounts.ts";
import { inboxLayout, inboxRow, type InboxClock } from "./inbox-rows.ts";
import { followCheckpoint, inboxCheckpoint } from "./inbox-checkpoint.ts";
import { followInboxSort } from "./inbox-sort.ts";
import { dispatchCommand } from "./commands.ts";
import { inboxOrganizer, type InboxOrganizer } from "./inbox-organize.ts";
import { PlaceAction, runPlace, type PlaceContext } from "./inbox-place.ts";
import { keepNone, type DismissedSends } from "./dismissed-sends.ts";
import { settleSend } from "./send-recovery.ts";
import { SendOps, retryOf } from "./send-ops.ts";

/**
 * Stops following; also what `inboxAction` needs to pin and move: the pins and moves shown
 * before the daemon confirms them, and the machine's sort.
 */
export type InboxFollow = (() => void) &
  PlaceContext & { dismissed?: DismissedSends; ops?: SendOps };
import type { PatchSink } from "./agents.ts";

/**
 * The inbox's confirmation generation: a monotonic fence so a cached confirmed row can never
 * read as fresh after the bridge loses freshness. Bumped only when a confirmed row stops
 * being the daemon's current list (connected, caught up, confirmed, error-free); carried
 * atomically on every connection patch and every inbox row. Native keeps the newest
 * generation it has seen and treats older confirmed rows as unconfirmed until their
 * snapshot returns. Missing generations (old payloads) never confirm.
 */
export interface ActivityGeneration {
  current(): number;
  /** Advance after losing confirmation; returns the new generation. */
  bump(): number;
}

export function makeActivityGeneration(): ActivityGeneration {
  let generation = 0;
  return {
    current: () => generation,
    bump: () => ++generation,
  };
}

export type { InboxClock } from "./inbox-rows.ts";
/** Native timers take 32-bit delays; a longer wait re-arms when it fires. */
const longestWait = 2 ** 31 - 1;

/*
 * The inbox as native rows: each thread's row with its ready-made status, the shared grouping
 * as ordered sections, and the outbox's unsent sends. Swift draws them and maps token keys to
 * colours; it never groups or labels. Rows are keyed by thread id and carry their machine; each
 * section row carries its shared rank, so the app merges every machine's runtime by rank.
 *
 * Nothing is sent until the SDK holds a list (read back from disk or from the daemon), so the
 * rows the phone kept from its last launch stay on screen instead of an empty inbox. While the
 * list is the daemon's current one, `save` keeps a checkpoint of it for the next launch
 * (`inbox-checkpoint.ts`).
 */

function inboxThread(
  store: SidebarSource,
  organizer: InboxOrganizer,
  id: string,
): InboxThread | undefined {
  const entry = organizer.entry(id);
  const machineId = organizer.machineId;
  return entry && { key: id, machineId, entry, unconfirmed: store.unconfirmed === true };
}

/**
 * Whether a row is the daemon's current list: connected, caught up, confirmed and error-free.
 * Carried atomically with each row so a cached done row can never read as a fresh completion.
 */
function isConfirmed(store: SidebarSource, online: boolean): boolean {
  return online && !store.syncing && store.unconfirmed !== true && !store.error;
}

export function followInbox(
  owner: ClientCore,
  machineId: string,
  pump: PatchSink,
  clock: InboxClock,
  generation: ActivityGeneration = makeActivityGeneration(),
  save?: (checkpoint: string) => void,
  /** The sort the phone last drew this machine's inbox in, until the machine says (`inbox-sort.ts`). */
  lastSort?: HomeSort,
  /** Failed sends the person took back or discarded: they leave Unsent and the transcript. */
  dismissed: DismissedSends = keepNone,
  /** Edits and retries of failed sends, one at a time per send; the row says which runs. */
  ops: SendOps = new SendOps(),
): InboxFollow {
  const store = owner.threads().store;
  const organizer = inboxOrganizer(owner, machineId, clock);
  const sends = owner.pendingSends();
  const connection = owner.connectionState();
  const online = () => connection.getSnapshot() === "ready";
  // Results that finished before this phone started following count as seen.
  const baseline = clock.now();
  // A sort chosen on any device regroups the list at once.
  const sort = followInboxSort(owner, clock, lastSort, () => sections());
  const context = () => ({
    machineId,
    now: clock.now(),
    baseline,
    accounts: accounts.views(),
    sortBy: sort.current(),
  });
  const row = (id: string) =>
    pump.put(`inbox:${id}`, () => {
      const thread = inboxThread(store, organizer, id);
      return {
        type: "inbox.row",
        id,
        row: thread
          ? {
              ...inboxRow(thread, context()),
              confirmed: isConfirmed(store, online()),
              generation: generation.current(),
            }
          : null,
      };
    });
  /** Whether the phone has been sent a list yet; until then it keeps what it last showed. */
  let shown = false;
  // A fresh account list re-issues every row, so provider marks gain or lose their bubble.
  const accounts = followAccounts(owner, () => {
    if (!shown) return;
    for (const id of store.ids) row(id);
  });
  const checkpoint = followCheckpoint(
    clock,
    () => store.loaded && isConfirmed(store, online()),
    () => inboxCheckpoint(store, context()),
    (json) => save?.(json),
  );
  // A snooze runs out on this phone's clock even while its machine is offline (and so can't
  // wake it): at the soonest end, the rows it ends say so and the sections regroup.
  let wake: { at: number; cancel: () => void } | undefined;
  const arm = (at: number | undefined) => {
    if (wake?.at === at) return;
    wake?.cancel();
    wake = undefined;
    if (at === undefined) return;
    const cancel = clock.set(Math.min(longestWait, Math.max(0, at - clock.now())), () => {
      wake = undefined;
      const now = clock.now();
      for (const id of store.ids) {
        const until = store.thread(id)?.snoozedUntil;
        if (until !== undefined && until <= now) row(id);
      }
      sections();
    });
    wake = { at, cancel };
  };
  // Read at delivery, so a burst of changes costs one grouping per frame.
  const sections = () => {
    if (!shown) return;
    if (save) checkpoint.touch();
    pump.put("inbox:sections", () => {
      const now = clock.now();
      const threads: InboxThread[] = [];
      for (const id of store.ids) {
        const thread = inboxThread(store, organizer, id);
        if (thread) threads.push(thread);
      }
      arm(inboxNextChange(threads, now));
      const unsent = sends
        .getSnapshot()
        .filter(
          (send) => !dismissed.has(send.commandId) && !owner.pendingSend(retryOf(send.commandId)),
        )
        .map((send) => ({ key: send.commandId, machineId, send }));
      // The inbox pages home; while the archive is open the store's own window is the archive's.
      // Only the daemon's own copy has a Settled section, so only it carries the daemon's total.
      return inboxLayout(threads, unsent, now, (store.homeWindow ?? store.window)?.before != null, {
        settledTotal: store.unconfirmed === true ? undefined : settledTotal(store.homeWindow),
        sortBy: sort.current(),
      });
    });
  };
  const pending = (id: string) =>
    pump.put(`pending:${id}`, () => {
      // A send sent again stands aside for its newer attempt, the one to act on.
      const send =
        dismissed.has(id) || owner.pendingSend(retryOf(id)) ? undefined : owner.pendingSend(id);
      return {
        type: "pending",
        id,
        row: send
          ? { ...pendingRow(send, connection.getSnapshot()), busy: ops.current(id) ?? null }
          : null,
      };
    });
  /** The thread ids the phone holds rows for, so one that leaves the list loses only its row. */
  let listed = new Set<string>();
  const gone = (id: string) =>
    pump.put(`inbox:${id}`, () => ({ type: "inbox.row", id, row: null }));
  let unconfirmed = store.unconfirmed === true;
  let fresh = isConfirmed(store, online());
  const change: ChangeTap = (changed) => {
    if (!shown && !store.loaded) return;
    // The first list the phone sees replaces what it kept, whatever changed to bring it.
    const keys = shown ? changed : "all";
    shown = true;
    const nowUnconfirmed = store.unconfirmed === true;
    const nowFresh = isConfirmed(store, online());
    // Losing confirmation advances the fence so older confirmed rows stop matching,
    // even when PatchPump delivers the connection and row frames separately.
    if (fresh && !nowFresh) generation.bump();
    const flipped = nowUnconfirmed !== unconfirmed || nowFresh !== fresh;
    unconfirmed = nowUnconfirmed;
    fresh = nowFresh;
    if (keys === "all") {
      pump.clear("inbox:");
      listed = new Set(store.ids);
      // The reset names every row that follows, so the phone keeps those it holds until each
      // fresh copy lands and drops only the rest: the list never blanks or jumps to the top.
      const ids = [...listed];
      pump.put("inbox:reset", () => ({ type: "inbox.reset", ids }));
      for (const id of listed) row(id);
    } else {
      // A thread joining or leaving the list touches only its own row. A reset here would
      // blank every row on the phone until the rest arrive, throwing the list to the top.
      // The SDK names "ids" on every thread patch, so only rows that joined are sent beside the
      // changed ones; each row's rank depends on that row alone, so the rest stay as they are.
      if (keys.has("ids")) {
        const now = new Set(store.ids);
        for (const id of listed) if (!now.has(id)) gone(id);
        if (!flipped) for (const id of now) if (!listed.has(id)) row(id);
        listed = now;
      }
      if (flipped) for (const id of store.ids) row(id);
      else for (const key of keys) if (key.startsWith("thread:")) row(key.slice(7));
    }
    sections();
  };
  const stops = [
    accounts.stop,
    // A pin or move shows on its row, and moves it, before the daemon confirms it.
    organizer.observe((id) => {
      if (!shown) return;
      row(id);
      sections();
    }),
    store.observe(change),
    owner.observePendingSends((id) => {
      pending(id);
      // A retry joining or going re-sends the attempt it stands for.
      if (id.endsWith(":retry")) pending(id.slice(0, -":retry".length));
      sections();
    }),
    ops.observe((id) => pending(id)),
    dismissed.observe((id) => {
      if (id !== undefined) pending(id);
      else for (const send of sends.getSnapshot()) pending(send.commandId);
      sections();
    }),
    // The connection patch is produced here, beside the rows that share its fence, so a
    // coalesced offline-to-ready still carries the advanced generation with the ready state.
    // Offline changes what a held send says ("Sends on reconnect"), and any freshness
    // flip (welcome before its snapshot, catch-up, error) re-issues every row with its
    // current confirmation even when the thread content itself did not change.
    connection.subscribe(() => {
      pump.put("connection", () => ({
        type: "connection",
        state: connection.getSnapshot(),
        generation: generation.current(),
      }));
      const nowFresh = isConfirmed(store, online());
      if (fresh && !nowFresh) generation.bump();
      const flipped = nowFresh !== fresh;
      fresh = nowFresh;
      if (flipped && shown) {
        for (const id of store.ids) row(id);
        sections();
      }
      for (const send of sends.getSnapshot()) pending(send.commandId);
    }),
  ];
  change("all");
  const stop = () => {
    for (const each of stops) each();
    sort.stop();
    checkpoint.stop();
    arm(undefined);
  };
  return Object.assign(stop, { organizer, sortBy: () => sort.current(), dismissed, ops });
}

function pendingRow(send: PendingSend, connection: string) {
  const status = unsentStatus(send, connection === "ready");
  return {
    id: send.commandId,
    threadId: send.threadId,
    state: send.state,
    waiting: send.waiting,
    text: preview(unsentText(send), 8192),
    /** Why it wasn't sent, behind Details; empty when the SDK kept no reason. */
    detail: send.state === "failed" && send.error ? preview(send.error, 2048) : "",
    /** Files and images on it: an edit changes its words and keeps them. */
    files:
      send.payload.input.filter((part) => part.type !== "text" && part.type !== "mention").length +
      (send.payload.context?.attachments?.length ?? 0),
    label: status.label,
    token: status.token,
  };
}

const InboxAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("archive"), threadId: ThreadId }),
  z.object({ kind: z.literal("unarchive"), threadId: ThreadId }),
  z.object({ kind: z.literal("settle"), threadId: ThreadId }),
  z.object({ kind: z.literal("unsettle"), threadId: ThreadId }),
  z.object({
    kind: z.literal("snooze"),
    threadId: ThreadId,
    preset: z.enum(["hour", "tomorrow", "monday"]),
  }),
  z.object({ kind: z.literal("wake"), threadId: ThreadId }),
  z.object({ kind: z.literal("more") }),
  /** A failed send the person took back into the composer or discarded; `restore` is Undo. */
  z.object({ kind: z.literal("dismissSend"), commandId: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("restoreSend"), commandId: z.string().min(1).max(256) }),
  /** Edit of a failed send: its full words, then new words saved in place in the outbox. */
  z.object({ kind: z.literal("sendWords"), commandId: z.string().min(1).max(256) }),
  z.object({
    kind: z.literal("editSend"),
    commandId: z.string().min(1).max(256),
    text: z.string().max(100_000),
  }),
]);

function payloadOf(action: z.infer<typeof InboxAction>, now: number): CommandPayload | undefined {
  switch (action.kind) {
    case "archive":
      return { type: "thread.archive", threadId: action.threadId };
    case "unarchive":
      return { type: "thread.unarchive", threadId: action.threadId };
    case "settle":
      return { type: "thread.settle", threadId: action.threadId };
    case "unsettle":
      return { type: "thread.unsettle", threadId: action.threadId };
    case "snooze": {
      const until = snoozePresets(now).find((preset) => preset.id === action.preset)?.until;
      return until === undefined
        ? undefined
        : { type: "thread.snooze", threadId: action.threadId, until };
    }
    case "wake":
      return { type: "thread.snooze", threadId: action.threadId, until: null };
    default:
      return undefined;
  }
}

/**
 * Organization goes through the SDK's durable outbox: admission first, the receipt later. Pins
 * and moves show at once through `inbox`, what `followInbox` returned.
 */
export function inboxAction(
  owner: ClientCore,
  raw: unknown,
  requestId: string,
  pump: PatchSink,
  inbox?: PlaceContext & { dismissed?: DismissedSends; ops?: SendOps },
): void {
  const place = PlaceAction.safeParse(raw);
  if (place.success && inbox) {
    void runPlace(inbox, place.data, requestId, pump);
    return;
  }
  const parsed = InboxAction.safeParse(raw);
  if (!parsed.success) {
    pump.put(`admission:${requestId}`, () => ({
      type: "admission",
      id: requestId,
      ok: false,
      message: "Could not read that inbox action.",
    }));
    return;
  }
  const action = parsed.data;
  if (
    action.kind === "dismissSend" ||
    action.kind === "restoreSend" ||
    action.kind === "sendWords" ||
    action.kind === "editSend"
  ) {
    void settleSend(owner, action, requestId, pump, inbox?.dismissed, inbox?.ops ?? new SendOps());
    return;
  }
  if (action.kind === "more") {
    void owner.threadsMore().catch(() =>
      pump.put("error", () => ({
        type: "error",
        message: "Older threads load once your machine is connected.",
      })),
    );
    return;
  }
  void dispatchCommand(owner, payloadOf(action, host.now()), requestId, pump);
}
