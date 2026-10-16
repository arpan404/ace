import { catalogDisplayName } from "@ace/ui-core";
import type { ClientApi } from "@ace/client";
import type { CatalogEntry, CatalogList } from "@ace/protocol";
import type { z } from "zod";

type Target = Pick<z.input<typeof CatalogList>, "threadId" | "draft" | "workspace">;

interface CatalogSnapshot {
  entries: readonly CatalogEntry[];
  stale: boolean;
}

/**
 * The last settled snapshot per discovery target, per environment (client). Reopening the slash
 * menu resubscribes even when its target is unchanged, so without this the menu flashes back to
 * loading on every `/`. Replaying the cached snapshot keeps the ready list on screen while the
 * fresh read arrives. The key carries the workspace, provider and instance identity (threads
 * carry their own session), so one provider's skills never leak into another's menu.
 */
const catalogSnapshots = new WeakMap<ClientApi, Map<string, CatalogSnapshot>>();
const maxCatalogSnapshots = 32;

export function catalogTargetKey(target: Target): string {
  if (target.threadId !== undefined) return `thread:${target.threadId}`;
  if (target.draft !== undefined)
    return `draft:${target.draft.draftId}\0${target.draft.workspaceId}\0${target.draft.provider}\0${target.draft.instanceId ?? ""}`;
  if (target.workspace !== undefined)
    return `workspace:${target.workspace.workspaceId}\0${target.workspace.provider}\0${target.workspace.instanceId ?? ""}`;
  return "";
}

function snapshotsFor(client: ClientApi): Map<string, CatalogSnapshot> {
  let snapshots = catalogSnapshots.get(client);
  if (!snapshots) {
    snapshots = new Map();
    catalogSnapshots.set(client, snapshots);
  }
  return snapshots;
}

function rememberSnapshot(
  client: ClientApi,
  target: Target,
  entries: readonly CatalogEntry[],
  stale: boolean,
): void {
  // A transient empty read while discovery runs must not evict a good snapshot.
  if (stale && entries.length === 0) return;
  const key = catalogTargetKey(target);
  if (!key) return;
  const snapshots = snapshotsFor(client);
  snapshots.delete(key);
  snapshots.set(key, { entries, stale });
  if (snapshots.size > maxCatalogSnapshots) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
}

/** One bounded discovery subscription, shared by the composer and Skills. */
export function watchCatalog(
  client: ClientApi,
  target: Target,
  receive: (entries: readonly CatalogEntry[], stale: boolean) => void,
  failed: () => void,
): () => void {
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  let receivedPush = false;
  let unavailable = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cached = snapshotsFor(client).get(catalogTargetKey(target));
  if (cached) {
    // Serve the last snapshot instantly; the live read below refreshes it in place.
    receive(cached.entries, cached.stale);
  }
  const fail = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!controller.signal.aborted && !unavailable) {
      unavailable = true;
      failed();
    }
  };
  const accept = (entries: readonly CatalogEntry[], stale: boolean) => {
    if (unavailable && stale) return;
    if (stale) timer ??= setTimeout(fail, 10_000);
    else {
      unavailable = false;
      clearTimeout(timer);
      timer = undefined;
    }
    rememberSnapshot(client, target, entries, stale);
    receive(entries, stale);
  };
  timer = setTimeout(fail, 10_000);
  const stop = client.onMessage((message) => {
    if (message.type === "catalog.changed" && message.requestId === requestId) {
      receivedPush = true;
      accept(message.entries, message.stale);
    } else if (message.type === "error" && message.requestId === requestId) fail();
  });
  void client
    .request(
      { type: "catalog.list", ...target, subscribe: true, limit: 512 },
      { requestId, signal: controller.signal },
    )
    .then(
      (reply) => {
        if (!controller.signal.aborted && !receivedPush) accept(reply.entries, reply.stale);
      },
      () => {
        fail();
      },
    );
  return () => {
    if (timer) clearTimeout(timer);
    controller.abort();
    stop();
    try {
      if (client.state === "ready") client.send({ type: "catalog.unsubscribe", requestId });
    } catch {
      // Disconnect can race the worker mirror; the closed socket owns its subscriptions.
    }
  };
}

/** The same provenance label in Skills and the slash menu. */
export function catalogSourceLabel(entry: CatalogEntry): string | undefined {
  switch (entry.source.scope) {
    case "project":
      return "Project";
    case "global":
      return "Global";
    case "plugin":
      return entry.source.plugin === catalogDisplayName(entry)
        ? undefined
        : (entry.source.plugin ?? "Plugin");
    case "ace":
      return undefined;
  }
}
