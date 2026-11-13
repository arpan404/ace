import {
  emptySpadeConversation,
  emptySpadeGroup,
  foldSpade,
  foldSpadeGroup,
  parseSpadeEvents,
  parseSpadeLiveFrame,
  spadeGroupView,
  spadeView,
  type SpadeConversationState,
  type SpadeFoldInput,
  type SpadeGroupState,
  type SpadeGroupView,
  type SpadeView,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, SpadeRequestError } from "./spade-requests.ts";
import type { LiveEnd, SpadeTransport } from "./spade-transport.ts";

/** What the shell can't control: the frame clock and timers. */
export interface FollowDeps {
  /** Run `callback` before the next paint; frames that arrive together render once. */
  frame(callback: () => void): void;
  later(delay: number, callback: () => void): () => void;
}

export interface FollowSnapshot<V = SpadeView> {
  view: V;
  /** Why the conversation can't be followed live, in words; undefined while it can. */
  problem: string | undefined;
}

/** Events per page when a conversation first opens. */
const pageSize = 200;

/** Ends after which a new stream picks up where the last left off, after a pause. */
const resumable = new Set<LiveEnd>(["restarted", "closed", "unavailable", "limit"]);

/** How a conversation's inputs fold into what the person sees: a bot's chat, or a group's. */
export interface Folder<S, V> {
  empty(): S;
  fold(state: S, input: SpadeFoldInput): boolean;
  view(state: S): V;
  lastSeq(state: S): number;
  /** Messages sent from here that Spade hasn't stored yet. */
  pending(state: S): readonly { key: string }[];
}

const botFolder: Folder<SpadeConversationState, SpadeView> = {
  empty: emptySpadeConversation,
  fold: foldSpade,
  view: spadeView,
  lastSeq: (state) => state.lastSeq,
  pending: (state) => state.pending,
};

const groupFolder: Folder<SpadeGroupState, SpadeGroupView> = {
  empty: emptySpadeGroup,
  fold: foldSpadeGroup,
  view: spadeGroupView,
  lastSeq: (state) => state.lastSeq,
  pending: (state) => state.pending,
};

/**
 * One conversation followed live, straight from Spade or through the daemon (`SpadeTransport`).
 * Every stream asks for events after the last `seq` already folded, and the fold drops any it
 * has seen, so a reconnect, a socket move, a switch between the two ways or a Spade restart
 * never repeats or loses a message. A new stream opens when the transport can open one and
 * Spade is ready (`setReady`).
 */
export class LiveConversation<S, V> {
  private state: S;
  private snapshot: FollowSnapshot<V>;
  private listeners = new Set<() => void>();
  /** Frames beside the conversation itself (a bot's `computer`, `files`), by event. */
  private sideListeners = new Map<string, Set<(data: string) => void>>();
  private stops: (() => void)[] = [];
  /** The open stream; ended or closed streams are never this. */
  private stream: { close(): void } | undefined;
  private spadeReady = false;
  private framePending = false;
  /** The first open reads the history in pages before it follows live. */
  private paged = false;
  private paging = false;
  /** Stopped (unmounted): nothing opens again, however late a page or a timer finishes. */
  private stopped = true;
  private sends: { key: string; resolve(reached: boolean): void; cancel(): void }[] = [];
  private retryTimer: (() => void) | undefined;
  private retries = 0;
  private readonly link: SpadeTransport;
  private readonly conversation: string;
  private readonly deps: FollowDeps;
  private readonly folder: Folder<S, V>;

  constructor(link: SpadeTransport, conversation: string, deps: FollowDeps, folder: Folder<S, V>) {
    this.link = link;
    this.conversation = conversation;
    this.deps = deps;
    this.folder = folder;
    this.state = folder.empty();
    this.snapshot = { view: folder.view(this.state), problem: undefined };
  }

  get = (): FollowSnapshot<V> => this.snapshot;

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
      void this.page().finally(() => {
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
   * The history so far, a page at a time, each shown as it arrives; then the live stream picks
   * up after the last one. A page that fails leaves the rest to the live stream's backlog.
   */
  private async page() {
    for (;;) {
      const after = this.lastSeq;
      let body: string;
      try {
        body = await spadeHttp(
          this.link,
          "GET",
          `/v1/conversations/${segment(this.conversation)}/events?after=${after}&limit=${pageSize}`,
        );
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof SpadeRequestError && error.status === 404)
          this.setProblem("This conversation isn't in Spade any more.");
        return;
      }
      if (this.stopped) return;
      const page = parseSpadeEvents(body);
      if (!page) return;
      for (const stored of page) this.folder.fold(this.state, { kind: "stored", stored });
      this.publish();
      if (page.length < pageSize || this.lastSeq === after) return;
    }
  }

  private close() {
    const stream = this.stream;
    this.stream = undefined;
    stream?.close();
  }

  private frame(event: string, data: string) {
    for (const listener of this.sideListeners.get(event) ?? []) listener(data);
    const input = parseSpadeLiveFrame(event, data);
    if (input && this.folder.fold(this.state, input)) {
      this.retries = 0;
      this.schedule();
    }
    // Caught up: anything sent before this that Spade stored has arrived by now.
    this.settleSends(input?.kind === "caught_up");
  }

  private ended(reason: LiveEnd, status: number | undefined) {
    if (reason === "unsubscribed") return;
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
    this.snapshot = { view: this.folder.view(this.state), problem: this.snapshot.problem };
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

/** A bot's conversation, followed live. */
export class ConversationFollow extends LiveConversation<SpadeConversationState, SpadeView> {
  constructor(link: SpadeTransport, conversation: string, deps: FollowDeps) {
    super(link, conversation, deps, botFolder);
  }
}

/** A group's conversation (ADR 0132), followed live the same way. */
export class GroupFollow extends LiveConversation<SpadeGroupState, SpadeGroupView> {
  constructor(link: SpadeTransport, conversation: string, deps: FollowDeps) {
    super(link, conversation, deps, groupFolder);
  }
}
