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
  readonly #stop: () => void;

  /** `live`: the leased tail, whose change keys every view of the window follows. */
  constructor(live: ThreadSource, view: ThreadSource) {
    this.#view = view;
    const current = () => this.#view;
    this.#stop = live.observe((keys) => {
      if (keys !== "all" && keys.has("history")) {
        // Only the tail's paging moved; a window's own items never depend on it.
        const rest = new Set([...keys].filter((key) => key !== "history"));
        if (!rest.size) return;
        this.#emit(rest);
        return;
      }
      this.#emit(keys);
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

  dispose(): void {
    this.#stop();
    this.#taps.clear();
  }

  #emit(keys: Parameters<ChangeTap>[0]): void {
    for (const tap of this.#taps) tap(keys);
  }
}
