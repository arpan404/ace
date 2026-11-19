import type { Executor } from "./posix-lane-types.ts";

export interface HandleEntry {
  root: string;
  executor: Executor;
  /** dev:ino of what it names, when known. */
  identity: string | undefined;
}

/** Open handles: which thread owns each and which root it routes to. Ids are never reused. */
export class HandleTable {
  private readonly entries = new Map<number, HandleEntry>();
  private next = 0;

  /** A fresh handle id for a call that opens something. */
  allocate(): number {
    return ++this.next;
  }
  get(handle: number): HandleEntry | undefined {
    return this.entries.get(handle);
  }
  set(handle: number, entry: HandleEntry): void {
    this.entries.set(handle, entry);
  }
  delete(handle: number): void {
    this.entries.delete(handle);
  }
  /** A thread that serves no more: its handles are dead here; only that thread could close them. */
  forget(executor: Executor): void {
    for (const handle of executor.handles) this.entries.delete(handle);
    executor.handles.clear();
  }
}
