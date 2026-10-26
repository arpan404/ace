import type { ChangeTap, ClientCore } from "@ace/client";
import type { CommandPayload, ThreadListEntry } from "@ace/protocol";
import { patchedEntry, reflects, type OrganizePatch } from "@ace/ui-core";
import type { PatchSink } from "./agents.ts";
import { dispatchCommand } from "./commands.ts";
import type { InboxClock } from "./inbox-rows.ts";

/*
 * Organize actions shown on the phone before the daemon confirms them, as the web's Home list
 * shows them (`@ace/ui-core` `patchEntry`). Each action changes its thread's row at once and goes
 * through the SDK's durable outbox. It is dropped when the daemon's own entry shows it (or a
 * little after its receipt, should another device have changed the thread again), or at once
 * when it can't be saved or the daemon refuses it, which puts the row back. Offline it stays
 * shown until the outbox delivers it after a reconnect.
 */

/** After its receipt, how long an action waits at most for the list to show it. */
const settleMs = 5_000;

interface Pending {
  threadId: string;
  patch: OrganizePatch;
  at: number;
  /** The daemon's entry when the action was taken, so `reflects` can tell a fresh read time. */
  before: ThreadListEntry | undefined;
  /** The daemon accepted it; the action now only waits for the list to show it. */
  accepted: boolean;
  cancel?: () => void;
}

export interface InboxOrganizer {
  /** This machine, as the phone names it: moves name threads of every machine. */
  readonly machineId: string;
  /** The daemon's entry with this phone's unconfirmed actions applied. */
  entry(id: string): ThreadListEntry | undefined;
  /** Hear which thread's shown entry changed because an action was taken or dropped. */
  observe(listener: (threadId: string) => void): () => void;
  /**
   * Show `patch` on the thread now and send `payload`. `done` hears whether it was saved on
   * this device (the admission); the receipt arrives on the pump under `requestId`.
   */
  run(
    threadId: string,
    patch: OrganizePatch,
    payload: CommandPayload,
    requestId: string,
    pump: PatchSink,
  ): Promise<boolean>;
  stop(): void;
}

export function inboxOrganizer(
  owner: ClientCore,
  machineId: string,
  clock: InboxClock,
): InboxOrganizer {
  const store = owner.threads().store;
  const pending = new Map<string, Pending[]>();
  const listeners = new Set<(threadId: string) => void>();
  const changed = (threadId: string) => {
    for (const listener of listeners) listener(threadId);
  };
  const drop = (action: Pending) => {
    action.cancel?.();
    const list = pending.get(action.threadId);
    if (!list?.includes(action)) return;
    const rest = list.filter((other) => other !== action);
    if (rest.length) pending.set(action.threadId, rest);
    else pending.delete(action.threadId);
    changed(action.threadId);
  };
  /** Drop every accepted action the daemon's entry now shows. */
  const shown = (threadId: string) => {
    for (const action of pending.get(threadId) ?? [])
      if (action.accepted && reflects(store.thread(threadId), action.patch, action.before))
        drop(action);
  };
  const tap: ChangeTap = (keys) => {
    if (keys === "all" || keys.has("ids")) {
      for (const threadId of pending.keys()) shown(threadId);
      return;
    }
    for (const key of keys)
      if (key.startsWith("thread:") && pending.has(key.slice(7))) shown(key.slice(7));
  };
  const unobserve = store.observe(tap);
  return {
    machineId,
    entry(id) {
      const entry = store.thread(id);
      const list = pending.get(id);
      return entry && list?.length ? patchedEntry(entry, list) : entry;
    },
    observe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async run(threadId, patch, payload, requestId, pump) {
      const action: Pending = {
        threadId,
        patch,
        at: clock.now(),
        before: store.thread(threadId),
        accepted: false,
      };
      pending.set(threadId, [...(pending.get(threadId) ?? []), action]);
      changed(threadId);
      let saved = false;
      await dispatchCommand(owner, payload, requestId, pump, {
        saved: () => {
          saved = true;
        },
        receipt: (ok) => {
          if (!ok) return drop(action);
          action.accepted = true;
          action.cancel = clock.set(settleMs, () => drop(action));
          shown(threadId);
        },
      });
      if (!saved) drop(action);
      return saved;
    },
    stop() {
      unobserve();
      for (const list of pending.values()) for (const action of list) action.cancel?.();
      pending.clear();
      listeners.clear();
    },
  };
}
