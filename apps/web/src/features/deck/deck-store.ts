import { ConductorClient, type ClientApi, type ConductorWatch } from "@ace/client";
import {
  ConductorCommandPayload,
  type ConductorRunView,
  type ConductorSummary,
} from "@ace/protocol";
import { daemonErrorCode, describeDaemonError, refusalMessage } from "@/lib/daemon-command.ts";

/*
 * The daemon's conductor runs for one client (ADR 0060), through `ConductorClient`: the list
 * once per connection, a push watch (`conductor.changed`) on every run that can still move, and
 * one read of each finished run. Nothing polls: a watch reacquires its run after a reconnect,
 * and the list is read again then. Commands are durable `conductor.*` commands.
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
  /** Why the list couldn't be read, as a sentence (`describeDaemonError`). */
  error: string | undefined;
}

export class DeckCommandError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(deckErrorMessage(code));
    this.code = code;
  }
}

const commandErrors: Record<string, string> = {
  stale_gate: "That decision is out of date. The deck has moved on.",
  conductor_unavailable: "This daemon's Deck service isn't running.",
  conductor_executor_unavailable: "This daemon can't run decks: its conductor has no executor.",
  conductor_command_failed: "The daemon couldn't apply that to the deck.",
  already_exists: "A deck with that id already exists.",
  not_running: "The deck isn't running.",
  not_paused: "The deck isn't paused.",
  finished: "The deck has already finished.",
  run_limit: "This daemon holds as many decks as it can. Remove an old one first.",
};

export function deckErrorMessage(code: string): string {
  return commandErrors[code] ?? refusalMessage(code);
}

const listLimit = 32;
/** The daemon allows 8 subscriptions per socket; leave room for other screens. */
const watchLimit = 6;
const moving = new Set<ConductorSummary["phase"]>(["planning", "running", "paused", "cancelling"]);

export interface DeckStoreDeps {
  id(): string;
}

export class DeckStore {
  private client: ClientApi;
  private conductor: ConductorClient;
  private state: DeckSnapshot = { ready: false, entries: [], error: undefined };
  private listeners = new Set<() => void>();
  /** Live watches by run id, with what unsubscribes from them. */
  private watches = new Map<string, { watch: ConductorWatch; stop(): void }>();
  private epoch = 0;
  private started = false;
  constructor(client: ClientApi, deps: DeckStoreDeps) {
    this.client = client;
    this.conductor = new ConductorClient(client, () => `deck-${deps.id()}`);
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
    // A watched run reports the change itself; a new deck is watched from its first view.
    if (payload.type === "conductor.start") this.follow(payload.runId);
    else if (!this.watches.has(payload.runId)) await this.read(payload.runId, this.epoch);
  }
  /** Read the list again after it failed (Try again). */
  retry(): void {
    if (this.client.connectionState().getSnapshot() === "ready") void this.load();
  }
  /** Follow a run the list didn't include (an old deck opened by its link). */
  ensure(runId: string): void {
    if (!this.state.ready || this.find(runId)) return;
    void this.read(runId, this.epoch);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    const connection = this.client.connectionState();
    let previous = connection.getSnapshot();
    connection.subscribe(() => {
      const next = connection.getSnapshot();
      if (next === "ready" && previous !== "ready") void this.load();
      previous = next;
    });
    if (previous === "ready") void this.load();
  }
  private emit(next: Partial<DeckSnapshot>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  private find(runId: string): DeckEntry | undefined {
    return this.state.entries.find((entry) => entry.summary.id === runId);
  }
  /** Store a run's view. The daemon repeats unchanged views; those change nothing here. */
  private put(view: ConductorRunView): void {
    const current = this.find(view.id);
    if (current?.view && JSON.stringify(current.view) === JSON.stringify(view)) return;
    const entry = { summary: view, view };
    const entries = current
      ? this.state.entries.map((known) => (known.summary.id === view.id ? entry : known))
      : [entry, ...this.state.entries];
    this.emit({ entries });
    if (!moving.has(view.phase)) queueMicrotask(() => this.release(view.id));
  }
  private async load(): Promise<void> {
    const epoch = ++this.epoch;
    try {
      const { runs } = await this.conductor.list({ limit: listLimit });
      if (epoch !== this.epoch) return;
      const known = new Map(this.state.entries.map((entry) => [entry.summary.id, entry]));
      this.emit({
        ready: true,
        error: undefined,
        entries: runs.map((summary) => ({ summary, view: known.get(summary.id)?.view })),
      });
      await Promise.all(
        runs.map((summary) =>
          moving.has(summary.phase) && this.follow(summary.id)
            ? undefined
            : this.read(summary.id, epoch),
        ),
      );
    } catch (error) {
      if (epoch === this.epoch)
        this.emit({ ready: true, error: describeDaemonError(daemonErrorCode(error)) });
    }
  }
  /** Watch a run that can still move; false when every watch is taken. */
  private follow(runId: string): boolean {
    if (this.watches.has(runId)) return true;
    if (this.watches.size >= watchLimit) return false;
    const watch = this.conductor.watch(runId);
    const stop = watch.run.subscribe(() => {
      const view = watch.run.getSnapshot();
      if (view) this.put(view);
    });
    this.watches.set(runId, { watch, stop });
    return true;
  }
  /** A run that finished needs no watch; the slot goes to a moving run that has none. */
  private release(runId: string): void {
    const held = this.watches.get(runId);
    if (!held) return;
    held.stop();
    held.watch.close();
    this.watches.delete(runId);
    const waiting = this.state.entries.find(
      (entry) =>
        !this.watches.has(entry.summary.id) && moving.has((entry.view ?? entry.summary).phase),
    );
    if (waiting) this.follow(waiting.summary.id);
  }
  private async read(runId: string, epoch: number): Promise<void> {
    try {
      const view = await this.conductor.get(runId);
      if (epoch !== this.epoch) return;
      this.put(view);
      if (moving.has(view.phase)) this.follow(runId);
    } catch {
      // A run that can't be read stays as the list described it.
    }
  }
}
