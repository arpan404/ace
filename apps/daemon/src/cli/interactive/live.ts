import type { Client, ThreadSubscription } from "@ace/client";
import type { Project, ThreadListEntry } from "@ace/protocol";
import { projectLabel } from "@ace/ui-core";
import { homeRows, type HomeRow } from "./home-rows.ts";
import type { OpenRequest } from "./request-answer.ts";
import { threadRequests } from "./requests.ts";

/**
 * What the interactive views read from the daemon, through `@ace/client`'s own stores (ADR
 * 0178 §9): the thread list (`threads()`), the threads with open requests, and the open row's
 * agents (`thread(id)`). The client owns reconnects and the outbox; this only holds leases and
 * says when something changed.
 */
export interface Live {
  rows(now: number): HomeRow[];
  /** The list hasn't arrived (nor a cached copy of it). */
  loading(): boolean;
  /** The list is the daemon's, current and whole: worth keeping for the next run. */
  confirmed(): boolean;
  /** Words for a connection that isn't live, or undefined while it is. */
  connection(): string | undefined;
  requests(): OpenRequest[];
  entry(id: string): ThreadListEntry | undefined;
  /** Leases the open row's thread for as long as its tree shows; `undefined` lets it go. */
  follow(id: string | undefined): ThreadSubscription | undefined;
  followed(): ThreadSubscription | undefined;
  projects(): readonly Project[];
  close(): void;
}

/** Threads with open requests followed at once, at most; the rest wait their turn. */
const requestLeases = 16;

export function openLive(client: Client, signal: AbortSignal, changed: () => void): Live {
  const list = client.threads();
  const names = new Map<string, Project>();
  const asking = new Map<string, { lease: ThreadSubscription; stop: () => void }>();
  let slot: { id: string; lease: ThreadSubscription; stop: () => void } | undefined;
  const entries = (): ThreadListEntry[] =>
    list.store.ids.flatMap((id) => {
      const entry = list.store.thread(id);
      return entry ? [entry] : [];
    });
  const watch = (lease: ThreadSubscription) => lease.store.observe(() => changed());
  // Follow the threads that wait on the person, so their requests can be answered here.
  const syncRequests = () => {
    const wanted = new Set<string>(
      entries()
        .filter((entry) => entry.status.state === "needs_you" && !entry.archivedAt)
        .slice(0, requestLeases)
        .map((entry) => entry.id),
    );
    for (const [id, held] of asking)
      if (!wanted.has(id)) {
        held.stop();
        held.lease.release();
        asking.delete(id);
      }
    for (const id of wanted)
      if (!asking.has(id)) {
        try {
          const lease = client.thread(id, { optional: true });
          asking.set(id, { lease, stop: watch(lease) });
        } catch {
          // The client's subscription budget is spent; the row still says it needs you.
        }
      }
  };
  const stopList = list.store.observe(() => {
    syncRequests();
    changed();
  });
  const stopConnection = client.connectionState().subscribe(changed);
  syncRequests();
  // Project names: read once, quietly; rows show ids until then.
  void client
    .request(
      { type: "projects.request", operation: { op: "workspace.list", limit: 100 } },
      { signal },
    )
    .then((response) => {
      if (response.result.kind !== "projects") return;
      for (const project of response.result.projects) names.set(project.id, project);
      changed();
    })
    .catch(() => {});
  return {
    rows: (now) =>
      homeRows({
        entries: entries(),
        now,
        unconfirmed: list.store.unconfirmed === true || client.state !== "ready",
        projectName: (id) => projectLabel(id, names.get(id)),
      }),
    loading: () => !list.store.loaded && list.store.ids.length === 0,
    confirmed: () =>
      client.state === "ready" &&
      list.store.loaded === true &&
      list.store.unconfirmed !== true &&
      list.store.syncing !== true,
    connection: () => {
      if (client.state === "ready") return list.store.syncing ? "Catching up…" : undefined;
      return "Reconnecting to ace…";
    },
    requests: () => {
      const all: OpenRequest[] = [];
      for (const [id, held] of asking) {
        const entry = list.store.thread(id);
        if (!entry) continue;
        all.push(
          ...threadRequests(held.lease.store, {
            title: entry.title,
            project: projectLabel(entry.workspaceId, names.get(entry.workspaceId)),
            provider: entry.provider,
          }),
        );
      }
      return all.toSorted((a, b) => a.interaction.createdAt - b.interaction.createdAt);
    },
    entry: (id) => list.store.thread(id),
    follow(id) {
      if (slot && slot.id === id) return slot.lease;
      slot?.stop();
      slot?.lease.release();
      slot = undefined;
      if (!id) return undefined;
      const lease = client.thread(id);
      slot = { id, lease, stop: watch(lease) };
      return lease;
    },
    followed: () => slot?.lease,
    projects: () => [...names.values()],
    close() {
      stopList();
      stopConnection();
      for (const held of asking.values()) {
        held.stop();
        held.lease.release();
      }
      asking.clear();
      slot?.stop();
      slot?.lease.release();
      slot = undefined;
      list.release();
    },
  };
}
