import type { Event, ThreadId } from "@ace/protocol";

type Listener = (events: Event[]) => void;
interface Source {
  subscribe(listener: Listener): () => void;
}
/** One thread subscription: `deliver` hears its thread's events in a batch, and the batch's head. */
export type ThreadRoute = (events: Event[], head: number) => void;

const none: Event[] = [];
const routes = new WeakMap<Source, ThreadRoutes>();

/**
 * Hear a store's batches for one thread. Every thread subscription on a store shares one store
 * listener, which splits each batch by thread once: a subscription gets only its thread's
 * events, and the batch's head (so it can report progress) when it has none.
 */
export function routeThread(source: Source, thread: ThreadId, route: ThreadRoute): () => void {
  let shared = routes.get(source);
  if (!shared) {
    shared = new ThreadRoutes(source, () => routes.delete(source));
    routes.set(source, shared);
  }
  return shared.add(thread, route);
}

class ThreadRoutes {
  private entries = new Set<{ thread: ThreadId; route: ThreadRoute }>();
  private watched = new Map<ThreadId, number>();
  private stop: () => void;
  private empty: () => void;
  constructor(source: Source, empty: () => void) {
    this.empty = empty;
    this.stop = source.subscribe((events) => this.dispatch(events));
  }
  add(thread: ThreadId, route: ThreadRoute): () => void {
    const entry = { thread, route };
    this.entries.add(entry);
    this.watched.set(thread, (this.watched.get(thread) ?? 0) + 1);
    return () => {
      if (!this.entries.delete(entry)) return;
      const count = (this.watched.get(thread) ?? 1) - 1;
      if (count) this.watched.set(thread, count);
      else this.watched.delete(thread);
      if (this.entries.size) return;
      this.stop();
      this.empty();
    };
  }
  private dispatch(batch: Event[]): void {
    const head = batch.at(-1)?.seq;
    if (head === undefined) return;
    const byThread = new Map<ThreadId, Event[]>();
    for (const event of batch) {
      if (!this.watched.has(event.threadId)) continue;
      const events = byThread.get(event.threadId);
      if (events) events.push(event);
      else byThread.set(event.threadId, [event]);
    }
    // A route added while this batch is delivered starts with the next one, as a listener would.
    let failure: { error: unknown } | undefined;
    for (const entry of Array.from(this.entries)) {
      if (!this.entries.has(entry)) continue;
      try {
        entry.route(byThread.get(entry.thread) ?? none, head);
      } catch (error) {
        // Every subscription still hears the batch; the store reports the first failure.
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }
}
