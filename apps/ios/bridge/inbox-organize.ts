import type { ClientCore } from "@ace/client";
import type { CommandPayload, ThreadListEntry } from "@ace/protocol";
import { PendingActions, runOrganize, type OrganizePatch } from "@ace/ui-core";
import type { PatchSink } from "./agents.ts";
import { dispatchCommand, type Receipt } from "./commands.ts";
import type { InboxClock } from "./inbox-rows.ts";

/*
 * Organize actions shown on the phone before the daemon confirms them, by the same rules as the
 * web's Home list (`@ace/ui-core` `runOrganize`): each changes its thread's row at once, goes
 * through the SDK's durable outbox, and is dropped once the daemon's entry shows it, or at once
 * when it can't be saved or the daemon refuses it, which puts the row back.
 */

export interface InboxOrganizer {
  /** This machine, as the phone names it: moves name threads of every machine. */
  readonly machineId: string;
  /** The daemon's entry with this phone's unconfirmed actions applied. */
  entry(id: string): ThreadListEntry | undefined;
  /** Every listed thread's entry, as `entry` shows it. */
  entries(): ThreadListEntry[];
  /** Hear which thread's shown entry changed because an action was taken or dropped. */
  observe(listener: (threadId: string) => void): () => void;
  /**
   * Show `patch` on the thread now and send `payload`. Resolves with whether it was saved on
   * this device (the admission); the receipt arrives on the pump under `requestId`, and to
   * `heard` when given.
   */
  run(
    threadId: string,
    patch: OrganizePatch,
    payload: CommandPayload,
    requestId: string,
    pump: PatchSink,
    heard?: (result: Receipt) => void,
  ): Promise<boolean>;
}

class Refused extends Error {}

export function inboxOrganizer(
  owner: ClientCore,
  machineId: string,
  clock: InboxClock,
): InboxOrganizer {
  const store = owner.threads().store;
  const pending = new PendingActions();
  return {
    machineId,
    entry(id) {
      const entry = store.thread(id);
      return entry && pending.apply(entry);
    },
    entries() {
      return store.ids.flatMap((id) => {
        const entry = store.thread(id);
        return entry ? [pending.apply(entry)] : [];
      });
    },
    observe: pending.subscribe,
    run(threadId, patch, payload, requestId, pump, heard) {
      return new Promise<boolean>((admitted) => {
        const send = () =>
          new Promise<void>((accepted, refused) => {
            let saved = false;
            void dispatchCommand(owner, payload, requestId, pump, {
              saved: () => {
                saved = true;
                admitted(true);
              },
              receipt: (result) => {
                heard?.(result);
                if (result.ok) accepted();
                else refused(new Refused(requestId));
              },
            }).then(() => {
              if (saved) return;
              admitted(false);
              refused(new Refused(requestId));
            });
          });
        const action = {
          key: pending.nextKey(),
          threadId,
          patch,
          at: clock.now(),
          label: requestId,
          waiting: true,
        };
        // A refusal already put the row back and told the phone why, under `requestId`.
        runOrganize(pending, store, clock, action, send).catch(() => {});
      });
    },
  };
}
