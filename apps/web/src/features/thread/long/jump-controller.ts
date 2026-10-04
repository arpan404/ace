import type { ClientApi, ThreadSource } from "@ace/client";
import { windowSource } from "@ace/client-react";
import type { ItemsWindowResponse } from "@ace/protocol";
import {
  windowTurnOrdinals,
  meetsTail,
  newerRequest,
  olderRequest,
  openWindow,
  withNewer,
  withOlder,
  type JumpWindow,
  type TailEdge,
} from "@ace/ui-core";

/*
 * Jumping within one thread (ADR 0062). The thread view keeps its live tail leased and, while
 * the reader looks at older history, one jumped window beside it. A new jump replaces the
 * window and sliding pages it without growing it. When it reaches the tail it joins it: the
 * transcript shows the window followed by the tail's newer items (deduplicated by id), one
 * contiguous run, until the reader follows the live end and the window is dropped. Never two
 * runs with a hole between them. Plain state with a subscribe/snapshot pair: the async
 * ordering (aborts, stale replies) lives here, not in effects.
 */

/** A request to bring one item into view (and, from a search, the words to mark in it). */
export interface Focus {
  itemId: string;
  nonce: number;
  query?: string | undefined;
}

export interface JumpSnapshot {
  window: JumpWindow | undefined;
  /** The window overlaps the live tail: the tail's newer items follow it. */
  joined: boolean;
  /** The turn the reader jumped to, named in the context bar; undefined for a sequence jump. */
  turn: number | undefined;
  loading: "jump" | "older" | "newer" | undefined;
  failed: string | undefined;
  focus: Focus | undefined;
  /**
   * Each window item's root turn, from where the turn index says turns start (a window's old
   * items may outlive the client's runs). Filled in once the index answers.
   */
  turns: ReadonlyMap<string, number> | undefined;
}

/** What the controller needs from the live tail: its edge, and where a turn starts in it. */
export interface LiveTail extends TailEdge {
  /** The first item of root turn `ordinal` if the tail holds it. */
  firstItemOf(ordinal: number): string | undefined;
}

/** Items kept before a jump target, so the turn before it gives context. */
const contextBefore = 30;
/** Items around a search hit or a sequence target. */
const aroundBefore = 60;

const idle: JumpSnapshot = {
  window: undefined,
  joined: false,
  turn: undefined,
  loading: undefined,
  failed: undefined,
  focus: undefined,
  turns: undefined,
};
/** Turn starts kept for windows: a page of the index either side of where the reader is. */
const keptStarts = 300;

export class JumpController {
  private state: JumpSnapshot = idle;
  private listeners = new Set<() => void>();
  private abort: AbortController | undefined;
  private nonce = 0;
  private client: ClientApi;
  private threadId: string;
  /** Where turns start (ordinal → creation sequence), for the windows' turns. */
  private starts = new Map<number, { startSeq: number; endSeq: number }>();
  private tail: () => LiveTail = () => ({
    order: [],
    before: undefined,
    firstItemOf: () => undefined,
  });
  constructor(client: ClientApi, threadId: string) {
    this.client = client;
    this.threadId = threadId;
  }
  /** Where the leased live tail stands; the thread view keeps it current. */
  setTail(tail: () => LiveTail): void {
    this.tail = tail;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = (): JumpSnapshot => this.state;

  private set(patch: Partial<JumpSnapshot>): void {
    const window = this.state.window;
    this.state = { ...this.state, ...patch };
    if (this.state.window !== window) {
      this.state = { ...this.state, turns: this.turnsOf(this.state.window) };
      if (this.state.window) void this.learnTurns(this.state.window);
    }
    for (const listener of this.listeners) listener();
  }
  private turnsOf(window: JumpWindow | undefined): ReadonlyMap<string, number> | undefined {
    if (!window || !this.starts.size) return undefined;
    const starts: { ordinal: number; startSeq: number }[] = [];
    for (const [ordinal, turn] of this.starts) starts.push({ ordinal, startSeq: turn.startSeq });
    return windowTurnOrdinals(window, starts);
  }
  /** Read the turn index around the window until its items' turns are known (a few pages). */
  private async learnTurns(window: JumpWindow): Promise<void> {
    const seqOf = (index: number) => {
      const item = window.items.at(index);
      return item ? window.seqs.get(item.id) : undefined;
    };
    const first = seqOf(0);
    const last = seqOf(-1);
    if (first === undefined || last === undefined) return;
    for (let reads = 0; reads < 4 && this.state.window === window; reads++) {
      const known = [...this.starts].toSorted((a, b) => a[0] - b[0]);
      const low = known[0];
      const high = known.at(-1);
      let request: { before?: number; after?: number } | undefined;
      if (!low || !high) request = this.state.turn ? { before: this.state.turn + 26 } : {};
      else if (first < low[1].startSeq && low[0] > 1) request = { before: low[0] };
      else if (last > high[1].endSeq) request = { after: high[0] };
      if (!request) break;
      let page;
      try {
        page = await this.client.turnsPage({ threadId: this.threadId, limit: 50, ...request });
      } catch {
        return;
      }
      if (!page.turns.length) break;
      for (const turn of page.turns)
        this.starts.set(turn.ordinal, { startSeq: turn.startSeq, endSeq: turn.endSeq });
      if (this.starts.size > keptStarts) {
        const sorted = [...this.starts.keys()].toSorted((a, b) => a - b);
        const keep = new Set(sorted.slice(-keptStarts));
        for (const ordinal of sorted) if (!keep.has(ordinal)) this.starts.delete(ordinal);
      }
      if (this.state.window === window) {
        this.state = { ...this.state, turns: this.turnsOf(window) };
        for (const listener of this.listeners) listener();
      }
    }
  }
  private focus(itemId: string, query?: string): Focus {
    return { itemId, nonce: ++this.nonce, query };
  }
  /** Starts a request, cancelling the one in flight; resolves undefined if it was replaced. */
  private async fetch(
    kind: NonNullable<JumpSnapshot["loading"]>,
    input: Parameters<ClientApi["itemsWindow"]>[0],
  ): Promise<ItemsWindowResponse | undefined> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.set({ loading: kind, failed: undefined });
    try {
      const reply = await this.client.itemsWindow(input, { signal: abort.signal });
      return abort.signal.aborted ? undefined : reply;
    } catch {
      if (!abort.signal.aborted)
        this.set({
          loading: undefined,
          failed:
            kind === "jump"
              ? "Couldn't load that part of the thread."
              : "Couldn't load more of the thread.",
        });
      return undefined;
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  /** Bring root turn `ordinal` into view: in place when the tail holds it, else a window. */
  async toTurn(ordinal: number): Promise<void> {
    const inTail = this.tail().firstItemOf(ordinal);
    if (inTail) {
      this.abort?.abort();
      this.set({ ...idle, focus: this.focus(inTail) });
      return;
    }
    const reply = await this.fetch("jump", {
      threadId: this.threadId,
      turnOrdinal: ordinal,
      before: contextBefore,
      after: 199 - contextBefore,
    });
    if (!reply) return;
    this.land(openWindow(reply), ordinal);
  }

  /**
   * Bring the item at or after creation sequence `seq` into view (a search hit, which names
   * its turn when the index knows it, and the words to mark).
   */
  async toSeq(seq: number, options: { turn?: number | null; query?: string } = {}): Promise<void> {
    const reply = await this.fetch("jump", {
      threadId: this.threadId,
      aroundSeq: seq,
      before: aroundBefore,
      after: 199 - aroundBefore,
    });
    if (!reply) return;
    this.land(openWindow(reply), options.turn ?? undefined, options.query);
  }

  private land(window: JumpWindow, turn: number | undefined, query?: string): void {
    const target = window.targetId;
    const tail = this.tail();
    // The target is in the tail already (a recent turn, a fresh hit): no window needed.
    if (target && tail.order.includes(target)) {
      this.set({ ...idle, focus: this.focus(target, query) });
      return;
    }
    this.set({
      window,
      joined: meetsTail(window, tail),
      turn,
      loading: undefined,
      failed: undefined,
      focus: target ? this.focus(target, query) : undefined,
    });
  }

  /** Slide the window toward older history. */
  async older(): Promise<void> {
    const window = this.state.window;
    const request = window && olderRequest(window);
    if (!window || !request || this.state.loading) return;
    const reply = await this.fetch("older", { threadId: this.threadId, ...request });
    if (!reply || this.state.window !== window) return;
    this.set({ window: withOlder(window, reply), loading: undefined });
  }

  /**
   * Slide the window toward the live tail. Once it reaches the tail it joins it, so the
   * reader's place is kept and the tail's newer items follow.
   */
  async newer(): Promise<void> {
    const window = this.state.window;
    if (!window || this.state.joined || this.state.loading) return;
    const request = newerRequest(window);
    if (!request) return;
    const reply = await this.fetch("newer", { threadId: this.threadId, ...request });
    if (!reply || this.state.window !== window) return;
    const next = withNewer(window, reply);
    this.set({ window: next, joined: meetsTail(next, this.tail()), loading: undefined });
  }

  /**
   * The tail moved (new items, or older ones paged out): a joined window that no longer
   * overlaps it has a hole after it again, so it stops showing the tail and offers to load on.
   */
  tailMoved(): void {
    const { window, joined } = this.state;
    if (!window || !joined) return;
    if (!meetsTail(window, this.tail())) this.set({ joined: false });
  }

  /** Back to the live tail; the window is discarded at once. */
  live(): void {
    this.abort?.abort();
    this.abort = undefined;
    if (this.state !== idle) this.set({ ...idle });
  }

  /** Forget a failure the reader has seen. */
  dismissError(): void {
    if (this.state.failed) this.set({ failed: undefined, loading: undefined });
  }

  /** Cancel what is in flight (the thread view unmounting). */
  dispose(): void {
    this.abort?.abort();
    this.abort = undefined;
  }
}

/** The thread as the transcript shows it while a window is open: its items, live the rest. */
export function jumpedSource(
  live: ThreadSource,
  window: JumpWindow,
  joined: boolean,
): ThreadSource {
  return windowSource(live, { items: window.items, before: window.before, joined });
}
