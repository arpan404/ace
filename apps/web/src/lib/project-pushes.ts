import type { WorkspaceChanged } from "@ace/protocol";

/*
 * Pushed project changes over list reads. A daemon pushes `workspace.changed` while a paged
 * `workspaces.list` read may be out; that read's pages can predate the push. Rather than
 * cancelling the read and starting over (on a slow link, a stream of pushes would restart it
 * forever), every push is applied to the list held now and kept while a read is out, then
 * applied again over that read's list when it lands. Pushes always win over older reads.
 */

/** One pushed change: a project as it is now, or one gone. */
export type ProjectPush<P> = { put: P } | { drop: string };

/** The push a `workspace.changed` carries, or undefined when it carries no project to put. */
export function pushOf<P>(
  change: WorkspaceChanged,
  project: (p: NonNullable<WorkspaceChanged["workspace"]>) => P,
): ProjectPush<P> | undefined {
  if (change.change === "removed") return { drop: change.workspaceId };
  return change.workspace ? { put: project(change.workspace) } : undefined;
}

/** `list` with `push` applied: the project replaced in place (or added), or left out. */
export function applyPush<P extends { id: string }>(list: readonly P[], push: ProjectPush<P>): P[] {
  if ("drop" in push) return list.filter((each) => each.id !== push.drop);
  const at = list.findIndex((each) => each.id === push.put.id);
  if (at < 0) return [...list, push.put];
  return list.map((each, index) => (index === at ? push.put : each));
}

/** The pushes one daemon's list has had while a read of it was out. */
export class ProjectPushes<P extends { id: string }> {
  private seq = 0;
  private reading = 0;
  private held: { seq: number; push: ProjectPush<P> }[] = [];
  /** Keep `push` for every read out now; with none out, nothing needs it. */
  record(push: ProjectPush<P>): void {
    this.seq++;
    if (this.reading > 0) this.held.push({ seq: this.seq, push });
  }
  /** Run `read`, then apply over its list every push recorded since it began. */
  async track(read: () => Promise<P[]>): Promise<P[]> {
    const since = this.seq;
    this.reading++;
    try {
      const list = await read();
      return this.held
        .filter((each) => each.seq > since)
        .reduce((current, each) => applyPush(current, each.push), list);
    } finally {
      this.reading--;
      if (this.reading === 0) this.held = [];
    }
  }
}

/** One ledger per daemon client, kept as long as the client is. */
export function pushesFor<P extends { id: string }>(
  ledgers: WeakMap<object, ProjectPushes<P>>,
  client: object,
): ProjectPushes<P> {
  let ledger = ledgers.get(client);
  if (!ledger) {
    ledger = new ProjectPushes<P>();
    ledgers.set(client, ledger);
  }
  return ledger;
}
