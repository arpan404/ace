import type { ClientApi } from "@ace/client";
import {
  ConductorCommandPayload,
  type ConductorRunView,
  type ConductorSummary,
  type ServerMessage,
} from "@ace/protocol";

/*
 * The daemon's conductor runs for one client (ADR 0017, 0057): `conductor.request` lists them
 * and reads each run's view; runs that can still move are subscribed, so `conductor.changed`
 * keeps them live. Commands are durable `conductor.*` commands. A reconnect starts over, since
 * subscriptions belong to the socket.
 */

/** A run as the daemon last reported it; `view` is missing until its first read lands. */
export interface DeckEntry {
  summary: ConductorSummary;
  view: ConductorRunView | undefined;
}
export interface DeckSnapshot {
  /** False until the first list arrives; screens show nothing rather than "no decks". */
  ready: boolean;
  entries: readonly DeckEntry[];
  /** When this client first saw each open gate, by gate id: the view carries no timestamps. */
  seen: ReadonlyMap<string, number>;
  /** The list couldn't be read (an older daemon, or the conductor service is down). */
  error: string | undefined;
}

export class DeckCommandError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(deckErrorMessage(code));
    this.code = code;
  }
}

export function deckErrorMessage(code: string): string {
  switch (code) {
    case "stale_gate":
      return "That decision is out of date. The deck has moved on.";
    case "conductor_unavailable":
      return "This daemon's conductor isn't running.";
    case "conductor_executor_unavailable":
      return "This daemon can't run decks yet: its conductor has no executor.";
    case "forbidden":
      return "This device isn't allowed to run decks.";
    default:
      return `The deck refused the command (${code}).`;
  }
}

const noop = () => {};
const listLimit = 32;
/** The daemon allows 8 subscriptions per socket; leave room for other screens. */
const subscriptionLimit = 6;
const moving = new Set<ConductorSummary["phase"]>(["planning", "running", "paused", "cancelling"]);

export interface DeckStoreDeps {
  now(): number;
  id(): string;
}

export class DeckStore {
  private client: ClientApi;
  private deps: DeckStoreDeps;
  private state: DeckSnapshot = { ready: false, entries: [], seen: new Map(), error: undefined };
  private listeners = new Set<() => void>();
  /** Our subscription ids on the current socket, by run id. */
  private subscriptions = new Map<string, string>();
  private epoch = 0;
  private stop: (() => void) | undefined;
  constructor(client: ClientApi, deps: DeckStoreDeps) {
    this.client = client;
    this.deps = deps;
  }
  snapshot = (): DeckSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => this.listeners.delete(listener);
  };
  /** Send a `conductor.*` command; rejects with the daemon's reason when it refuses. */
  async send(payload: ConductorCommandPayload): Promise<void> {
    const result = await this.client.command(ConductorCommandPayload.parse(payload));
    if (!result.ok) throw new DeckCommandError(result.error ?? "refused");
    // A subscribed run reports the change itself; anything else is read again.
    if (!this.subscriptions.has(payload.runId)) await this.read(payload.runId, this.epoch);
  }
  /** Read a run the list didn't include (an old deck opened by its link). */
  ensure(runId: string): void {
    if (!this.state.ready || this.find(runId)) return;
    void this.read(runId, this.epoch);
  }

  private start(): void {
    if (this.stop) return;
    const connection = this.client.connectionState();
    let previous = connection.getSnapshot();
    const stopState = connection.subscribe(() => {
      const next = connection.getSnapshot();
      if (next === "ready" && previous !== "ready") void this.load();
      previous = next;
    });
    let stopMessages = noop;
    try {
      stopMessages = this.client.onMessage((message) => this.receive(message));
    } catch {
      // A closed client has nothing to push.
    }
    this.stop = () => {
      stopState();
      stopMessages();
    };
    if (previous === "ready") void this.load();
  }
  private emit(next: Partial<DeckSnapshot>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  private find(runId: string): DeckEntry | undefined {
    return this.state.entries.find((entry) => entry.summary.id === runId);
  }
  private receive(message: ServerMessage): void {
    if (message.type !== "conductor.changed") return;
    const runId = [...this.subscriptions].find(([, id]) => id === message.subscriptionId)?.[0];
    if (runId === message.run.id) this.put(message.run);
  }
  /** Store a run's view, and stamp gates this client hasn't seen before. */
  private put(view: ConductorRunView): void {
    const now = this.deps.now();
    const seen = new Map(this.state.seen);
    for (const gate of view.needsUser) if (!seen.has(gate.id)) seen.set(gate.id, now);
    const entry = { summary: view, view };
    const entries = this.find(view.id)
      ? this.state.entries.map((current) => (current.summary.id === view.id ? entry : current))
      : [entry, ...this.state.entries];
    this.emit({ entries, seen });
  }
  private async load(): Promise<void> {
    const epoch = ++this.epoch;
    this.subscriptions.clear();
    try {
      const reply = await this.client.request({
        type: "conductor.request",
        operation: { op: "list", limit: listLimit },
      });
      if (epoch !== this.epoch) return;
      if (!reply.ok) {
        this.emit({ ready: true, error: deckErrorMessage(reply.error ?? "conductor_unavailable") });
        return;
      }
      const summaries = reply.runs ?? [];
      const known = new Map(this.state.entries.map((entry) => [entry.summary.id, entry]));
      this.emit({
        ready: true,
        error: undefined,
        entries: summaries.map((summary) => ({
          summary,
          view: known.get(summary.id)?.view,
        })),
      });
      await Promise.all(summaries.map((summary) => this.read(summary.id, epoch, summary.phase)));
    } catch (error) {
      if (epoch === this.epoch)
        this.emit({
          ready: true,
          error: error instanceof Error ? error.message : "The deck list didn't load.",
        });
    }
  }
  /** Read one run: subscribe while it can still move and a subscription is free, else get. */
  private async read(runId: string, epoch: number, phase?: ConductorSummary["phase"]) {
    const live =
      (phase === undefined || moving.has(phase)) &&
      !this.subscriptions.has(runId) &&
      this.subscriptions.size < subscriptionLimit;
    const subscriptionId = live ? `deck-${this.deps.id()}` : undefined;
    if (subscriptionId) this.subscriptions.set(runId, subscriptionId);
    try {
      const reply = await this.client.request({
        type: "conductor.request",
        operation: subscriptionId
          ? { op: "subscribe", runId, subscriptionId }
          : { op: "get", runId },
      });
      if (epoch !== this.epoch) return;
      if (!reply.ok || !reply.run) {
        if (subscriptionId) this.subscriptions.delete(runId);
        return;
      }
      this.put(reply.run);
    } catch {
      if (subscriptionId && this.subscriptions.get(runId) === subscriptionId)
        this.subscriptions.delete(runId);
    }
  }
}
