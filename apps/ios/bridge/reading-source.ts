import type { ChangeTap, ThreadSource } from "@ace/client";

/*
 * The history window as one thread source that never changes identity (ADR 0062). The shared
 * window controller replaces its window as the reader pages, jumps or the tail joins it; the
 * row and block followers keep following this one source, and each replacement reaches them
 * as the keys it changed (the order, and the items that came, went or were replaced), so the
 * phone receives the rows a page added or evicted, never the whole window again.
 */
export class ReadingSource {
  readonly source: ThreadSource;
  #view: ThreadSource;
  readonly #taps = new Set<ChangeTap>();
  #heldOrder: readonly string[] | undefined;
  #heldIds: ReadonlySet<string> = new Set();
  readonly #stop: () => void;

  /** `live`: the leased tail, whose change keys every view of the window follows. */
  constructor(live: ThreadSource, view: ThreadSource) {
    this.#view = view;
    const current = () => this.#view;
    this.#stop = live.observe((keys) => {
      if (keys === "all") {
        this.#emit(keys);
        return;
      }
      // The tail's paging never moves a window's own items, and a change to an item the view
      // doesn't show (the tail streaming past a detached window) is not the view's to hear.
      const held = this.#held();
      const rest = new Set<string>();
      for (const key of keys)
        if (key !== "history" && (!key.startsWith("item:") || held.has(key.slice(5))))
          rest.add(key);
      if (rest.size) this.#emit(rest);
    });
    this.source = {
      get error() {
        return current().error;
      },
      get syncing() {
        return current().syncing ?? false;
      },
      get unconfirmed() {
        return current().unconfirmed ?? false;
      },
      get thread() {
        return current().thread;
      },
      get queue() {
        return current().queue;
      },
      get context() {
        return current().context;
      },
      get cursor() {
        return current().cursor;
      },
      get order() {
        return current().order;
      },
      get itemsBefore() {
        return current().itemsBefore;
      },
      agentIds: () => current().agentIds(),
      runIds: () => current().runIds?.() ?? [],
      children: (agentId) => current().children(agentId),
      interactionIds: () => current().interactionIds(),
      taskIds: () => current().taskIds(),
      item: (id) => current().item(id),
      itemSeq: (id) => current().itemSeq?.(id),
      deleted: (id) => current().deleted?.(id) ?? false,
      agent: (id) => current().agent(id),
      run: (id) => current().run(id),
      interaction: (id) => current().interaction(id),
      task: (id) => current().task(id),
      usage: (id) => current().usage(id),
      contextMeter: (id) => current().contextMeter(id),
      usageSnapshot: (key) => current().usageSnapshot(key),
      truncated: (id) => current().truncated(id),
      observe: (tap) => {
        this.#taps.add(tap);
        return () => this.#taps.delete(tap);
      },
      select: (keys, selector, equal) => current().select(keys, selector, equal),
    };
  }

  /**
   * Show `view` instead: the followers hear the order changed (rows that left it go) and which
   * kept items are a different copy now. Linear in the window's length, never in the thread's.
   */
  replace(view: ThreadSource): void {
    const old = this.#view;
    if (old === view) return;
    this.#view = view;
    const keys = new Set<string>(["order"]);
    for (const id of view.order) if (old.item(id) !== view.item(id)) keys.add(`item:${id}`);
    this.#emit(keys);
  }

  /** The ids the view shows, rebuilt only when its order changes (new rows, a new window). */
  #held(): ReadonlySet<string> {
    const order = this.#view.order;
    if (this.#heldOrder !== order) {
      this.#heldOrder = order;
      this.#heldIds = new Set(order);
    }
    return this.#heldIds;
  }

  dispose(): void {
    this.#stop();
    this.#taps.clear();
  }

  #emit(keys: Parameters<ChangeTap>[0]): void {
    for (const tap of this.#taps) tap(keys);
  }
}
