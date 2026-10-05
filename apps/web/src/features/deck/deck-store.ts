import { ConductorClient, type ClientApi, type ConductorWatch } from "@ace/client";
import {
  ConductorCommandPayload,
  type ConductorRunView,
  type ConductorSummary,
} from "@ace/protocol";
import { daemonErrorCode, describeDaemonError, refusalMessage } from "@/lib/daemon-command.ts";
import { documentVisibility, type PageVisibility } from "@/lib/page-visibility.ts";

/*
 * The daemon's conductor runs for one client (ADR 0060), through `ConductorClient`: the list
 * once per connection (a page at a time), a push watch (`conductor.changed`) on the runs that
 * matter most, and reads for the rest. The daemon allows a few watches per socket, so they go
 * to the open deck first, then decks waiting on a decision, then the most recently changed;
 * a moving deck without one is read again every 30s while the page is visible. A watch
 * reacquires its run after a reconnect, and the list is read again then. Commands are durable
 * `conductor.*` commands.
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
  /** The daemon has older decks than the pages read so far. */
  more: boolean;
  /** Runs read on their own (an old deck opened by link) that the daemon couldn't give. */
  missing: ReadonlySet<string>;
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
  budget_must_increase: "Raise the budget above what the deck has now.",
  deadline_must_be_future: "Pick a deadline later than now.",
  merge_not_ready: "That card can't merge yet.",
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
/** How often a moving deck without a watch is read again while the page is visible. */
export const unwatchedReadMs = 30_000;
const moving = new Set<ConductorSummary["phase"]>(["planning", "running", "paused", "cancelling"]);

export interface DeckStoreDeps {
  id(): string;
  /** Timers, injected so tests drive them. */
  every?(ms: number, run: () => void): () => void;
  visibility?: PageVisibility;
}

const intervals = (ms: number, run: () => void) => {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
};

export class DeckStore {
  private client: ClientApi;
  private conductor: ConductorClient;
  private state: DeckSnapshot = {
    ready: false,
    entries: [],
    error: undefined,
    more: false,
    missing: new Set(),
  };
  private listeners = new Set<() => void>();
  /** Live watches by run id, with what unsubscribes from them. */
  private watches = new Map<string, { watch: ConductorWatch; stop(): void }>();
  /** The deck on screen, which always holds a watch. */
  private opened: string | undefined;
  private next: string | undefined;
  private epoch = 0;
  private started = false;
  private stopReading: (() => void) | undefined;
  private deps: DeckStoreDeps;
  constructor(client: ClientApi, deps: DeckStoreDeps) {
    this.client = client;
    this.deps = deps;
    this.conductor = new ConductorClient(client, () => `deck-${deps.id()}`);
  }
  snapshot = (): DeckSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    // Unwatched moving decks are re-read only while something on screen reads the store.
    this.stopReading ??= (this.deps.every ?? intervals)(unwatchedReadMs, () => this.reread());
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.stopReading?.();
      this.stopReading = undefined;
    };
  };
  /** Send a `conductor.*` command; rejects with the daemon's reason when it refuses. */
  async send(payload: ConductorCommandPayload): Promise<void> {
    const result = await this.client.command(ConductorCommandPayload.parse(payload));
    if (!result.ok) throw new DeckCommandError(result.error ?? "refused");
    // A watched run reports the change itself; a new deck is the one about to open.
    if (payload.type === "conductor.start") {
      this.opened = payload.runId;
      await this.read(payload.runId, this.epoch);
    } else if (!this.watches.has(payload.runId)) await this.read(payload.runId, this.epoch);
  }
  /** Read the list again after it failed (Try again). */
  retry(): void {
    if (this.client.connectionState().getSnapshot() === "ready") void this.load();
  }
  /** Read the next page of older decks. */
  async more(): Promise<void> {
    const after = this.next;
    if (!after) return;
    const epoch = this.epoch;
    try {
      const { runs, next } = await this.conductor.list({ after, limit: listLimit });
      if (epoch !== this.epoch) return;
      const known = new Set(this.state.entries.map((entry) => entry.summary.id));
      this.next = next;
      this.emit({
        more: !!next,
        entries: [
          ...this.state.entries,
          ...runs
            .filter((summary) => !known.has(summary.id))
            .map((summary) => ({ summary, view: undefined })),
        ],
      });
      await Promise.all(runs.map((summary) => this.read(summary.id, epoch)));
    } catch (error) {
      if (epoch === this.epoch) this.emit({ error: describeDaemonError(daemonErrorCode(error)) });
    }
  }
  /**
   * The deck on screen: it is followed live, before any other, even when it wasn't in the list
   * (an old deck opened by its link).
   */
  ensure(runId: string): void {
    this.opened = runId;
    if (!this.state.ready) return;
    if (!this.find(runId)) void this.read(runId, this.epoch);
    else this.balance();
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
  /** Read every moving deck that holds no watch, while the page is visible. */
  private reread(): void {
    const visibility = this.deps.visibility ?? documentVisibility;
    if (!visibility.visible() || this.client.connectionState().getSnapshot() !== "ready") return;
    for (const entry of this.state.entries)
      if (!this.watches.has(entry.summary.id) && moving.has(phaseOf(entry) ?? "done"))
        void this.read(entry.summary.id, this.epoch);
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
    // A run that stopped moving or started waiting on a decision changes who holds a watch.
    if (
      phaseOf(current) !== view.phase ||
      !!current?.view?.needsUser.length !== !!view.needsUser.length
    )
      queueMicrotask(() => this.balance());
  }
  private async load(): Promise<void> {
    const epoch = ++this.epoch;
    try {
      const { runs, next } = await this.conductor.list({ limit: listLimit });
      if (epoch !== this.epoch) return;
      const known = new Map(this.state.entries.map((entry) => [entry.summary.id, entry]));
      this.next = next;
      this.emit({
        ready: true,
        error: undefined,
        more: !!next,
        entries: runs.map((summary) => ({ summary, view: known.get(summary.id)?.view })),
      });
      this.balance();
      await Promise.all(
        runs.map((summary) =>
          this.watches.has(summary.id) ? undefined : this.read(summary.id, epoch),
        ),
      );
      if (this.opened && !this.find(this.opened)) await this.read(this.opened, epoch);
    } catch (error) {
      if (epoch === this.epoch)
        this.emit({ ready: true, error: describeDaemonError(daemonErrorCode(error)) });
    }
  }
  /**
   * Give the watches to the moving runs that matter most: the open deck, then those waiting on
   * a decision (longest first), then the most recently changed. Watches on the rest close.
   */
  private balance(): void {
    const wanted = this.state.entries
      .filter((entry) => moving.has(phaseOf(entry) ?? "done"))
      .toSorted((a, b) => rank(b, this.opened) - rank(a, this.opened))
      .slice(0, watchLimit)
      .map((entry) => entry.summary.id);
    for (const runId of this.watches.keys()) if (!wanted.includes(runId)) this.release(runId);
    for (const runId of wanted) this.follow(runId);
  }
  private follow(runId: string): void {
    if (this.watches.has(runId) || this.watches.size >= watchLimit) return;
    const watch = this.conductor.watch(runId);
    const stop = watch.run.subscribe(() => {
      const view = watch.run.getSnapshot();
      if (view) this.put(view);
    });
    this.watches.set(runId, { watch, stop });
  }
  private release(runId: string): void {
    const held = this.watches.get(runId);
    if (!held) return;
    held.stop();
    held.watch.close();
    this.watches.delete(runId);
  }
  private async read(runId: string, epoch: number): Promise<void> {
    try {
      const view = await this.conductor.get(runId);
      if (epoch !== this.epoch) return;
      this.put(view);
      this.balance();
    } catch {
      // A run that can't be read stays as the list described it; one the list didn't have is
      // reported missing, so its page stops loading and says so.
      if (epoch === this.epoch && !this.find(runId))
        this.emit({ missing: new Set([...this.state.missing, runId]) });
    }
  }
}

function phaseOf(entry: DeckEntry | undefined): ConductorSummary["phase"] | undefined {
  return (entry?.view ?? entry?.summary)?.phase;
}

/** Watch priority: the open deck, then a deck waiting on a decision, then the latest change. */
function rank(entry: DeckEntry, opened: string | undefined): number {
  if (entry.summary.id === opened) return Number.MAX_SAFE_INTEGER;
  const view = entry.view;
  const gated = view?.needsUser.length ? 1 : 0;
  // Gated decks outrank any change time; among them the longest waiting comes first.
  const waited = view?.needsUser.reduce((min, gate) => Math.min(min, gate.gatedAt), Infinity);
  return gated
    ? Number.MAX_SAFE_INTEGER / 2 - (Number.isFinite(waited) ? (waited ?? 0) : 0)
    : (view?.updatedAt ?? 0);
}
