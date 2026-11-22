import type { SpadeLiveEndReason } from "@ace/protocol";
import {
  foldSpade,
  emptySpadeConversation,
  type SpadeConversationState,
  type SpadeFoldInput,
} from "./fold.ts";
import {
  emptySpadeGroup,
  foldSpadeGroup,
  spadeGroupView,
  type SpadeGroupState,
  type SpadeGroupView,
} from "./group-fold.ts";
import { spadeView, type SpadeView } from "./view.ts";
import { parseSpadeEvents, parseSpadeLiveFrame, type SpadeStored } from "./wire.ts";
import { SpadeRequestError } from "./request-error.ts";

/*
 * One Spade conversation followed live, as every client follows it: the web straight from Spade
 * or through its daemon, the iPhone's bridge always through the daemon. The way there is the
 * caller's (`SpadeFollowLink`); what to fold, when to open again and what to say is here.
 */

/**
 * How a live stream ended. `dropped`: the way it went is gone (the daemon socket dropped or
 * moved, or Spade wasn't at its address); open again, after the last `seq`, once it can.
 */
export type SpadeFollowEnd = SpadeLiveEndReason | "dropped";

/** The way to Spade a follow reads and streams through. */
export interface SpadeFollowLink {
  /** Whether a live stream can open now; a false answer is followed by `onOpenable`. */
  canOpen(): boolean;
  /** `listener` runs whenever a stream may open where it couldn't (or had to reopen). */
  onOpenable(listener: () => void): () => void;
  /** Opens a live stream (a `/v1/.../live?after=N` path); returns its close. */
  open(
    path: string,
    sink: {
      frame(event: string, data: string): void;
      ended(reason: SpadeFollowEnd, status?: number): void;
    },
  ): () => void;
  /** A GET's text on 2xx; anything else rejects, with a `SpadeRequestError` when Spade answered. */
  read(path: string): Promise<string>;
}

const segment = (id: string) => encodeURIComponent(id);

/** What the shell can't control: the frame clock and timers. */
export interface SpadeFollowDeps {
  /** Run `callback` before the next paint; frames that arrive together render once. */
  frame(callback: () => void): void;
  later(delay: number, callback: () => void): () => void;
}

export interface SpadeFollowSnapshot<V = SpadeView> {
  view: V;
  /** Why the conversation can't be followed live, in words; undefined while it can. */
  problem: string | undefined;
  /**
   * The view is only what this device kept from an earlier open (`seed`): Spade hasn't answered
   * since, so nothing in it is known to be still going or done.
   */
  kept: boolean;
}

/** Events per page when a conversation first opens. */
const pageSize = 200;
/** At most this many history pages are out at once, the one being folded included. */
const pagesInFlight = 8;

/** Ends after which a new stream picks up where the last left off, after a pause. */
const resumable = new Set<SpadeFollowEnd>(["restarted", "closed", "unavailable", "limit"]);

/** How a conversation's inputs fold into what the person sees: a bot's chat, or a group's. */
export interface SpadeFolder<S, V> {
  empty(): S;
  fold(state: S, input: SpadeFoldInput): boolean;
  view(state: S): V;
  lastSeq(state: S): number;
  /** Messages sent from here that Spade hasn't stored yet. */
  pending(state: S): readonly { key: string }[];
}

const botFolder: SpadeFolder<SpadeConversationState, SpadeView> = {
  empty: emptySpadeConversation,
  fold: foldSpade,
  view: spadeView,
  lastSeq: (state) => state.lastSeq,
  pending: (state) => state.pending,
};

const groupFolder: SpadeFolder<SpadeGroupState, SpadeGroupView> = {
  empty: emptySpadeGroup,
  fold: foldSpadeGroup,
  view: spadeGroupView,
  lastSeq: (state) => state.lastSeq,
  pending: (state) => state.pending,
};

/**
 * One conversation followed live, through whichever way the link takes (`SpadeFollowLink`).
 * Every stream asks for events after the last `seq` already folded, and the fold drops any it
 * has seen, so a reconnect, a socket move, a switch between the two ways or a Spade restart
 * never repeats or loses a message. A new stream opens when the transport can open one and
 * Spade is ready (`setReady`).
 */
export class SpadeLiveConversation<S, V> {
  private state: S;
  private snapshot: SpadeFollowSnapshot<V>;
  private listeners = new Set<() => void>();
  /** Frames beside the conversation itself (a bot's `computer`, `files`), by event. */
  private sideListeners = new Map<string, Set<(data: string) => void>>();
  /** Told whenever the live stream ends, before any reopen: what it said may be stale now. */
  private endListeners = new Set<() => void>();
  private stops: (() => void)[] = [];
  /** The open stream; ended or closed streams are never this. */
  private stream: { close(): void } | undefined;
  private spadeReady = false;
  private framePending = false;
  /** The first open reads the history in pages before it follows live. */
  private paged = false;
  /** How many events Spade is known to hold (`expect`), for the pages read at once. */
  private expected = 0;
  /** The state began from events kept on this device (`seed`). */
  private seeded = false;
  /** The last kept event as read, to check against Spade's own copy before going on from it. */
  private keptLast: string | undefined;
  /** ...and Spade hasn't answered since, so the view may be out of date. */
  private kept = false;
  private resetListeners = new Set<() => void>();
  private paging = false;
  /** Stopped (unmounted): nothing opens again, however late a page or a timer finishes. */
  private stopped = true;
  private sends: { key: string; resolve(reached: boolean): void; cancel(): void }[] = [];
  private retryTimer: (() => void) | undefined;
  private retries = 0;
  private readonly link: SpadeFollowLink;
  private readonly conversation: string;
  private readonly deps: SpadeFollowDeps;
  private readonly folder: SpadeFolder<S, V>;

  constructor(
    link: SpadeFollowLink,
    conversation: string,
    deps: SpadeFollowDeps,
    folder: SpadeFolder<S, V>,
  ) {
    this.link = link;
    this.conversation = conversation;
    this.deps = deps;
    this.folder = folder;
    this.state = folder.empty();
    this.snapshot = { view: folder.view(this.state), problem: undefined, kept: false };
  }

  get = (): SpadeFollowSnapshot<V> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Frames of `event` the stream carries beside the conversation (a bot's computer, its files
   * changing), as they arrive.
   */
  onSide(event: string, listener: (data: string) => void): () => void {
    const set = this.sideListeners.get(event) ?? new Set();
    set.add(listener);
    this.sideListeners.set(event, set);
    return () => set.delete(listener);
  }

  /** `listener` runs whenever the live stream ends (a drop, a restart), until the result. */
  onEnded(listener: () => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  /**
   * Events this device kept from an earlier open, in `seq` order, folded before `start`: the
   * conversation shows them at once (`kept` until the live stream catches up) and the first read
   * asks only for the last of them and what came after. Spade's copy of that last one must be
   * the kept one, or the kept events aren't its history and it is read again from the start.
   */
  seed(stored: readonly SpadeStored[]): void {
    if (!this.stopped || this.seeded || this.lastSeq > 0) return;
    for (const event of stored) this.folder.fold(this.state, { kind: "stored", stored: event });
    const last = stored.at(-1);
    if (this.lastSeq === 0 || last?.seq !== this.lastSeq) return;
    this.seeded = true;
    this.keptLast = JSON.stringify(last);
    this.kept = true;
    this.publish();
  }

  /**
   * Spade holds at least `seq` events (a bot's last message, as its list says): the first read
   * asks for every page up to there at once.
   */
  expect(seq: number): void {
    this.expected = Math.max(this.expected, seq);
  }

  /**
   * `listener` runs when the kept events turn out not to be Spade's (its history doesn't hold
   * the last of them as kept) and the conversation is read again from its start.
   */
  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

  /** The highest `seq` folded, for sends that need to know what the person saw. */
  get lastSeq(): number {
    return this.folder.lastSeq(this.state);
  }

  start(): void {
    this.stopped = false;
    this.stops.push(this.link.onOpenable(() => this.open()));
    this.open();
  }

  stop(): void {
    this.stopped = true;
    for (const stop of this.stops.splice(0)) stop();
    this.retryTimer?.();
    this.close();
  }

  /** Spade is ready (or not) to stream; a subscription opens once it is. */
  setReady(ready: boolean): void {
    this.spadeReady = ready;
    if (ready) this.open();
  }

  /** Try again after a problem. */
  retry(): void {
    this.setProblem(undefined);
    this.retries = 0;
    this.close();
    this.open();
  }

  /** Fold an input from this side (a message sent or refused). */
  apply(input: SpadeFoldInput): void {
    if (this.folder.fold(this.state, input)) this.publish();
    this.settleSends(false);
  }

  /**
   * Whether a message sent from here (`key`) reached Spade, when its send got no answer: true
   * once Spade's copy arrives; false if the stream catches up (after a reconnect, say) without
   * it, or `waitMs` passes first.
   */
  reached(key: string, waitMs = 30_000): Promise<boolean> {
    return new Promise((resolve) => {
      const cancel = this.deps.later(waitMs, () => this.settleSends(true, key));
      this.sends.push({ key, resolve, cancel });
      this.settleSends(false);
    });
  }

  /** Answer `reached` waits: a stored copy answers at once; a catch-up or a timeout, finally. */
  private settleSends(final: boolean, only?: string) {
    this.sends = this.sends.filter((send) => {
      if (only !== undefined && send.key !== only) return true;
      const stored = !this.folder.pending(this.state).some((message) => message.key === send.key);
      if (!stored && !final) return true;
      send.cancel();
      send.resolve(stored);
      return false;
    });
  }

  private open() {
    if (this.stopped || this.stream || this.paging || !this.spadeReady || !this.link.canOpen())
      return;
    if (this.snapshot.problem) return;
    if (!this.paged) {
      this.paging = true;
      // page() reports what stopped it; the end is marked either way.
      void this.page()
        .catch(() => {})
        .finally(() => {
          this.paging = false;
          this.paged = true;
          this.open();
        });
      return;
    }
    const path = `/v1/conversations/${segment(this.conversation)}/live?after=${this.lastSeq}`;
    const stream = { close: () => {} };
    this.stream = stream;
    stream.close = this.link.open(path, {
      frame: (event, data) => {
        if (this.stream === stream) this.frame(event, data);
      },
      ended: (reason, status) => {
        if (this.stream !== stream) return;
        this.stream = undefined;
        this.ended(reason, status);
      },
    });
  }

  /**
   * The history so far, a page at a time, shown once it is all folded (or a page fails): a page
   * from partway through would show its moment as now (an old reply still "writing", Stop) and the
   * conversation would open at its start, then jump. Then the live stream picks up after the last
   * page. A page that fails leaves the rest to the live stream's backlog.
   */
  private async page() {
    try {
      await this.pages();
    } finally {
      if (!this.stopped) this.publish();
    }
  }

  private async pages() {
    // Spade numbers a conversation's events from 1 with no gaps, so the pages up to how many it
    // holds (`expect`) are asked for at once rather than one after another. Each is folded only
    // if the page before ended right where it begins; otherwise the rest are read in turn.
    // From kept events, the first read starts at the last kept one, to check it is Spade's.
    const checking = this.keptLast;
    const start = checking === undefined ? this.lastSeq : this.lastSeq - 1;
    let first: Promise<SpadeStored[] | undefined> | undefined = this.readPage(start);
    const ahead: { after: number; page: Promise<SpadeStored[] | undefined> }[] = [];
    for (
      let after = this.lastSeq + pageSize;
      after < this.expected && ahead.length < pagesInFlight - 1;
      after += pageSize
    )
      ahead.push({ after, page: this.readPage(after).catch(() => undefined) });
    for (;;) {
      const after = first ? start : this.lastSeq;
      let page: SpadeStored[] | undefined;
      try {
        page = await (first ?? this.readPage(after));
        first = undefined;
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof SpadeRequestError && error.status === 404)
          this.setProblem("This conversation isn't in Spade any more.");
        return;
      }
      if (this.stopped || !page) return;
      if (checking !== undefined && this.keptLast !== undefined) {
        this.keptLast = undefined;
        // Spade holds a different event where the kept ones end, or none: they aren't its.
        if (JSON.stringify(page[0]) !== checking) {
          ahead.length = 0;
          this.forget();
          continue;
        }
      }
      if (!this.foldPage(page, after)) return;
      for (let next = ahead.shift(); next; next = ahead.shift()) {
        if (next.after !== this.lastSeq) break;
        const early = await next.page;
        if (this.stopped) return;
        if (!early) break;
        if (!this.foldPage(early, next.after)) return;
      }
      // Any left didn't line up: what follows is read in turn.
      ahead.length = 0;
    }
  }

  /** One page of history after `after`; undefined when the answer isn't a list. */
  private async readPage(after: number): Promise<SpadeStored[] | undefined> {
    const body = await this.link.read(
      `/v1/conversations/${segment(this.conversation)}/events?after=${after}&limit=${pageSize}`,
    );
    return parseSpadeEvents(body);
  }

  /** Folds a page read after `after`; whether more history may follow it. */
  private foldPage(page: readonly SpadeStored[], after: number): boolean {
    for (const stored of page) this.folder.fold(this.state, { kind: "stored", stored });
    return page.length >= pageSize && this.lastSeq !== after;
  }

  private close() {
    const stream = this.stream;
    this.stream = undefined;
    stream?.close();
  }

  private frame(event: string, data: string) {
    for (const listener of this.sideListeners.get(event) ?? []) listener(data);
    const input = parseSpadeLiveFrame(event, data);
    // Only the live stream catching up confirms what was kept: Stop and approvals wait for it.
    if (input?.kind === "caught_up" && this.kept) {
      this.kept = false;
      this.schedule();
    }
    if (input && this.folder.fold(this.state, input)) {
      this.retries = 0;
      this.schedule();
    }
    // Caught up: anything sent before this that Spade stored has arrived by now.
    this.settleSends(input?.kind === "caught_up");
  }

  /** The kept events aren't Spade's history: they go, and the reads start over from 1. */
  private forget() {
    this.state = this.folder.empty();
    this.seeded = false;
    this.kept = false;
    this.keptLast = undefined;
    for (const listener of this.resetListeners) listener();
  }

  private ended(reason: SpadeFollowEnd, status: number | undefined) {
    if (reason === "unsubscribed") return;
    for (const listener of this.endListeners) listener();
    // The way it went is gone: open again at once, the other way or when this one is back.
    if (reason === "dropped") return this.open();
    if (reason === "refused" && status === 404)
      return this.setProblem("This conversation isn't in Spade any more.");
    if (!resumable.has(reason)) return this.setProblem("Couldn't follow this conversation live.");
    // Open again soon, backing off so a stream that keeps ending doesn't spin. While Spade
    // restarts the attempt waits for it (`setReady`), whichever news comes first.
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.retries++, 6));
    this.retryTimer?.();
    this.retryTimer = this.deps.later(delay, () => this.open());
  }

  private setProblem(problem: string | undefined) {
    if (this.snapshot.problem === problem) return;
    this.snapshot = { ...this.snapshot, problem };
    this.notify();
  }

  private schedule() {
    if (this.framePending) return;
    this.framePending = true;
    this.deps.frame(() => {
      this.framePending = false;
      this.publish();
    });
  }

  private publish() {
    this.snapshot = {
      view: this.folder.view(this.state),
      problem: this.snapshot.problem,
      kept: this.kept,
    };
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

/** A bot's conversation, followed live. */
export class SpadeConversationFollow extends SpadeLiveConversation<
  SpadeConversationState,
  SpadeView
> {
  constructor(link: SpadeFollowLink, conversation: string, deps: SpadeFollowDeps) {
    super(link, conversation, deps, botFolder);
  }
}

/** A group's conversation (ADR 0132), followed live the same way. */
export class SpadeGroupFollow extends SpadeLiveConversation<SpadeGroupState, SpadeGroupView> {
  constructor(link: SpadeFollowLink, conversation: string, deps: SpadeFollowDeps) {
    super(link, conversation, deps, groupFolder);
  }
}
