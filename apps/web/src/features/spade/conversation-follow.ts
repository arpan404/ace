import { onSocketMove, type ClientApi } from "@ace/client";
import type { SpadeLiveEndReason } from "@ace/protocol";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeEvents,
  parseSpadeLiveFrame,
  spadeView,
  type SpadeFoldInput,
  type SpadeView,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, SpadeRequestError } from "./spade-requests.ts";

/** What the shell can't control: ids, the frame clock and timers. */
export interface FollowDeps {
  id(): string;
  /** Run `callback` before the next paint; frames that arrive together render once. */
  frame(callback: () => void): void;
  later(delay: number, callback: () => void): () => void;
}

export interface FollowSnapshot {
  view: SpadeView;
  /** Why the conversation can't be followed live, in words; undefined while it can. */
  problem: string | undefined;
}

/** Events per page when a conversation first opens. */
const pageSize = 200;

/** Ends after which a new subscription picks up where the last left off. */
const resumable = new Set<SpadeLiveEndReason>(["restarted", "closed", "unavailable", "limit"]);

/**
 * One conversation followed live through `spade.live.subscribe`. Every subscription asks for
 * events after the last `seq` already folded, and the fold drops any it has seen, so a
 * reconnect, a socket move or a Spade restart never repeats or loses a message. A new
 * subscription starts when the connection is ready and Spade is (`setReady`).
 */
export class ConversationFollow {
  private state = emptySpadeConversation();
  private snapshot: FollowSnapshot;
  private listeners = new Set<() => void>();
  private stops: (() => void)[] = [];
  private requestId: string | undefined;
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
  private readonly client: ClientApi;
  private readonly conversation: string;
  private readonly deps: FollowDeps;

  constructor(client: ClientApi, conversation: string, deps: FollowDeps) {
    this.client = client;
    this.conversation = conversation;
    this.deps = deps;
    this.snapshot = { view: spadeView(this.state), problem: undefined };
  }

  get = (): FollowSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The highest `seq` folded, for sends that need to know what the person saw. */
  get lastSeq(): number {
    return this.state.lastSeq;
  }

  start(): void {
    this.stopped = false;
    const connection = this.client.connectionState();
    try {
      this.stops.push(this.client.onMessage((message) => this.receive(message)));
    } catch {
      this.setProblem("Couldn't follow this conversation live. Reload to try again.");
    }
    this.stops.push(
      connection.subscribe(() => {
        // The daemon ends a socket's streams with it.
        if (connection.getSnapshot() !== "ready") this.requestId = undefined;
        else this.open();
      }),
      onSocketMove(this.client, () => {
        this.requestId = undefined;
        this.open();
      }),
    );
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
    if (!ready) this.requestId = undefined;
    else this.open();
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
    if (foldSpade(this.state, input)) this.publish();
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
      const stored = !this.state.pending.some((message) => message.key === send.key);
      if (!stored && !final) return true;
      send.cancel();
      send.resolve(stored);
      return false;
    });
  }

  private open() {
    if (
      this.stopped ||
      this.requestId ||
      this.paging ||
      !this.spadeReady ||
      this.client.state !== "ready"
    )
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
    const requestId = `spade-live-${this.deps.id()}`;
    this.requestId = requestId;
    const path = `/v1/conversations/${segment(this.conversation)}/live?after=${this.state.lastSeq}`;
    try {
      this.client.send({ type: "spade.live.subscribe", requestId, path });
    } catch {
      this.requestId = undefined;
    }
  }

  /**
   * The history so far, a page at a time, each shown as it arrives; then the live stream picks
   * up after the last one. A page that fails leaves the rest to the live stream's backlog.
   */
  private async page() {
    for (;;) {
      const after = this.state.lastSeq;
      let body: string;
      try {
        body = await spadeHttp(
          this.client,
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
      for (const stored of page) foldSpade(this.state, { kind: "stored", stored });
      this.publish();
      if (page.length < pageSize || this.state.lastSeq === after) return;
    }
  }

  private close() {
    const requestId = this.requestId;
    this.requestId = undefined;
    if (!requestId || this.client.state !== "ready") return;
    try {
      this.client.send({ type: "spade.live.unsubscribe", requestId });
    } catch {
      // The socket closed first; the daemon ended the stream with it.
    }
  }

  private receive(message: Parameters<Parameters<ClientApi["onMessage"]>[0]>[0]) {
    if (message.type === "spade.live.frame" && message.requestId === this.requestId) {
      const input = parseSpadeLiveFrame(message.event, message.data);
      if (input && foldSpade(this.state, input)) {
        this.retries = 0;
        this.schedule();
      }
      // Caught up: anything sent before this that Spade stored has arrived by now.
      this.settleSends(input?.kind === "caught_up");
      return;
    }
    if (message.type !== "spade.live.ended" || message.requestId !== this.requestId) return;
    this.requestId = undefined;
    const { reason } = message;
    if (reason === "unsubscribed") return;
    if (reason === "refused" && message.status === 404)
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
    this.snapshot = { view: spadeView(this.state), problem: this.snapshot.problem };
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}
