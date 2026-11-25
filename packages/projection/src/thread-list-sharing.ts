import type { ThreadListEntry, ThreadListView } from "@ace/protocol";
import { structuredCopy } from "./structured-copy.ts";

type Shares = NonNullable<ThreadListView["shares"]>;
type RowReferences = Shares["rows"][string];
type Workspace = Shares["workspaces"][number];
type Capabilities = Shares["effectiveCapabilities"][number];

class SharedValues<T> {
  readonly values: T[] = [];
  private readonly indices = new Map<string, number>();
  save(value: T | undefined): number | undefined {
    if (value === undefined) return undefined;
    const text = JSON.stringify(value);
    const index = this.indices.get(text);
    if (index !== undefined) return index;
    // Past this bound the row keeps its original data.
    if (this.values.length >= 64) return undefined;
    const next = this.values.length;
    this.indices.set(text, next);
    this.values.push(value);
    return next;
  }
}

/** Only snapshots need a dictionary. Individual live patches keep their existing shape. */
export function shareThreadList(view: ThreadListView): ThreadListView {
  const rows = Object.entries(view.threads);
  if (rows.length < 2) return view;
  const workspaces = new SharedValues<Workspace>();
  const effectiveCapabilities = new SharedValues<Capabilities>();
  const refs: [string, RowReferences][] = [];
  const threads = rows.map(([id, entry]): [string, ThreadListEntry] => {
    const workspace = workspaces.save(entry.details?.workspace);
    const capabilities = effectiveCapabilities.save(entry.effectiveCapabilities);
    if (workspace === undefined && capabilities === undefined) return [id, entry];

    const copy = { ...entry };
    if (workspace !== undefined && copy.details) {
      copy.details = { ...copy.details };
      delete copy.details.workspace;
    }
    if (capabilities !== undefined) delete copy.effectiveCapabilities;
    refs.push([id, { workspace, capabilities }]);
    return [id, copy];
  });
  if (!refs.length) return view;
  return {
    ...view,
    threads: Object.fromEntries(threads),
    shares: {
      workspaces: workspaces.values,
      effectiveCapabilities: effectiveCapabilities.values,
      rows: Object.fromEntries(refs),
    },
  };
}

/** Reconstruct independent rows before they reach the store, as an ordinary snapshot would. */
export function restoreThreadList(view: ThreadListView): void {
  const { shares } = view;
  if (!shares) return;
  delete view.shares;
  for (const [id, refs] of Object.entries(shares.rows)) {
    const entry = Object.hasOwn(view.threads, id) ? view.threads[id] : undefined;
    if (!entry) continue;
    const workspace = shares.workspaces[refs.workspace ?? -1];
    const capabilities = shares.effectiveCapabilities[refs.capabilities ?? -1];
    if (workspace) entry.details = { ...entry.details, workspace: structuredCopy(workspace) };
    if (capabilities) entry.effectiveCapabilities = structuredCopy(capabilities);
  }
}
