import type { ClientApi, Lease, SidebarSource } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { CommandPayload, ThreadListEntry } from "@ace/protocol";
import { patchedEntry, reflects, type OrganizePatch, type Timers } from "@ace/ui-core";
import { useMemo, useSyncExternalStore } from "react";
import { runCommand } from "@/lib/daemon-command.ts";
import {
  pendingActionsOf,
  type PendingAction,
  type PendingActions,
} from "@/lib/pending-actions.ts";

/** After its receipt, how long an action waits at most for the list to show it. */
const settleMs = 5_000;

/**
 * Organize actions applied at once (UX audit SY-10). Each runs as a durable command, saved
 * before it is sent and resent after a reconnect, while its change shows on the thread's list
 * entry here. The change goes when the daemon's entry shows it (or a little after the receipt,
 * should another device have changed it again), or at once when the daemon refuses it. One per
 * client, so every view in this window shows the same pending state.
 */
export class OrganizeOverlay {
  readonly pending: PendingActions;
  /** Titles the daemon refused, kept so the rename field can open again with them. */
  private refused = new Map<string, string>();
  private listeners = new Set<() => void>();
  private count = 0;
  private client: ClientApi;
  private timers: Timers;
  constructor(client: ClientApi, timers: Timers) {
    this.client = client;
    this.timers = timers;
    this.pending = pendingActionsOf(client);
  }
  /** `entry` as it shows here, with its pending actions applied. */
  apply(entry: ThreadListEntry): ThreadListEntry {
    const pending = this.pending.forThread(entry.id);
    return pending.length ? patchedEntry(entry, pending) : entry;
  }
  /** Hear when a refused title is kept or taken back. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** A title the daemon refused for this thread, until the rename field takes it back. */
  refusedTitle(threadId: string): string | undefined {
    return this.refused.get(threadId);
  }
  refuseTitle(threadId: string, title: string): void {
    this.refused.set(threadId, title);
    this.emit();
  }
  takeRefusedTitle(threadId: string): void {
    if (this.refused.delete(threadId)) this.emit();
  }
  /**
   * Show `patch` on the thread now and send `payload`. Resolves once the daemon has applied it;
   * rejects, with the change already undone here, when the daemon refuses it.
   */
  async run(
    threadId: string,
    patch: OrganizePatch,
    payload: CommandPayload,
    label: string,
    at: number,
  ): Promise<void> {
    const lease = this.client.threads();
    const before = lease.store.thread(threadId);
    const action: PendingAction = { key: ++this.count, threadId, patch, at, label, waiting: true };
    this.pending.add(action);
    try {
      await runCommand(this.client, payload);
    } catch (error) {
      this.pending.remove(action);
      lease.release();
      throw error;
    }
    this.pending.replace({ ...action, waiting: false });
    await this.shown(lease, threadId, patch, before);
    this.pending.remove(action);
    lease.release();
  }
  /** Resolves when the list shows `patch`, or after `settleMs` regardless. */
  private shown(
    lease: Lease<SidebarSource>,
    threadId: string,
    patch: OrganizePatch,
    before: ThreadListEntry | undefined,
  ): Promise<void> {
    return new Promise((resolve) => {
      const selection = lease.store.select([`thread:${threadId}`, "ids"], (reader) =>
        reflects(reader.thread(threadId), patch, before),
      );
      let finished = false;
      let unsubscribe: (() => void) | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        unsubscribe?.();
        cancel();
        resolve();
      };
      const cancel = this.timers.set(settleMs, finish);
      unsubscribe = selection.subscribe(() => {
        if (selection.getSnapshot()) finish();
      });
      if (selection.getSnapshot()) finish();
    });
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const browserTimers: Timers = {
  set(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
const overlays = new WeakMap<ClientApi, OrganizeOverlay>();

/** This client's overlay of organize actions not yet confirmed. */
export function useOrganizeOverlay(): OrganizeOverlay {
  const client = useClient();
  return useMemo(() => {
    let overlay = overlays.get(client);
    if (!overlay) {
      overlay = new OrganizeOverlay(client, browserTimers);
      overlays.set(client, overlay);
    }
    return overlay;
  }, [client]);
}

/** `entry` as this window shows it: with its organize actions applied before the daemon's. */
export function useOverlaidEntry(entry: ThreadListEntry | undefined): ThreadListEntry | undefined {
  const { pending } = useOrganizeOverlay();
  const threadId = entry?.id ?? "";
  const read = () => pending.forThread(threadId);
  const actions = useSyncExternalStore(pending.subscribe, read, read);
  return useMemo(
    () => (entry && actions.length ? patchedEntry(entry, actions) : entry),
    [entry, actions],
  );
}

/** A title the daemon refused for this thread, so its rename field opens again with it. */
export function useRefusedTitle(threadId: string): string | undefined {
  const overlay = useOrganizeOverlay();
  const read = () => overlay.refusedTitle(threadId);
  return useSyncExternalStore(overlay.subscribe, read, read);
}
