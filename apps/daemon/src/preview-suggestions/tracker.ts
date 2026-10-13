import { pollPorts, type Listener } from "@ace/preview/detection";
import type { PreviewSuggestion, ThreadId } from "@ace/protocol";
import type { PageFacts } from "./page-probe.ts";
import { PrintedUrls } from "./printed-urls.ts";
import { scopeListeners, unexplainedPids, type ThreadScope } from "./scope.ts";

/*
 * The dev servers each watched thread can preview. A thread is watched while some connection
 * holds a lease on it (each `preview.request` list that asks for suggestions renews one);
 * nothing is scanned while no thread is watched. Scans run adaptively (quickly after a change
 * or a printed address, backing off while nothing moves), and each connection is pushed a
 * thread's full list whenever it changes.
 */

/** The machine, as the tracker sees it. Every edge is injected. */
export interface SuggestionIo {
  listeners(): Promise<Listener[]>;
  parents(): Promise<Map<number, number>>;
  cwds(pids: readonly number[]): Promise<Map<number, string>>;
  probe(port: number): Promise<PageFacts>;
  /** The thread's roots and shells; undefined once the thread is gone. */
  scope(threadId: ThreadId): Promise<ThreadScope | undefined>;
  /** Feed the thread's terminal and agent-shell output until the returned stop is called. */
  follow(threadId: ThreadId, feed: (stream: string, chunk: string) => void): () => void;
}

export interface SuggestionTrackerOptions {
  io: SuggestionIo;
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  /** The daemon's own process and ports, which are never suggested. */
  daemon: number;
  daemonPorts(): ReadonlySet<number>;
  onError?(error: unknown): void;
  leaseMs?: number;
  minDelay?: number;
  maxDelay?: number;
}

type Push = (suggestions: readonly PreviewSuggestion[]) => void;
interface Watched {
  suggestions: PreviewSuggestion[];
  fingerprint: string;
  scanned: boolean;
  stop: () => void;
}
interface Page {
  facts: PageFacts | undefined;
  failures: number;
  probing: boolean;
}

/** Failed probes of one listener before it is taken for a non-HTTP server. */
const maxFailures = 5;
/** Probes started per scan. */
const probesPerScan = 4;
/** Suggestions per thread. */
const maxSuggestions = 64;

export class SuggestionTracker {
  private readonly options: SuggestionTrackerOptions;
  private readonly leases = new Map<string, Map<ThreadId, { until: number; push: Push }>>();
  private readonly threads = new Map<ThreadId, Watched>();
  private readonly pages = new Map<string, Page>();
  private readonly cwdCache = new Map<number, string>();
  private readonly printed = new PrintedUrls();
  private scanning: Promise<void> | undefined;
  private loop: AbortController | undefined;
  private nudge: (() => void) | undefined;
  private closed = false;
  constructor(options: SuggestionTrackerOptions) {
    this.options = options;
  }

  /**
   * Hold `threadId` for `session` (renewing its lease) and return the thread's current
   * suggestions; `push` receives every later change while the lease lasts.
   */
  async watch(session: string, threadId: ThreadId, push: Push): Promise<PreviewSuggestion[]> {
    if (this.closed) return [];
    const held = this.leases.get(session) ?? new Map<ThreadId, { until: number; push: Push }>();
    this.leases.set(session, held);
    held.set(threadId, { until: this.options.now() + (this.options.leaseMs ?? 20_000), push });
    let thread = this.threads.get(threadId);
    if (!thread) {
      const watched: Watched = { suggestions: [], fingerprint: "[]", scanned: false, stop: noop };
      this.threads.set(threadId, watched);
      watched.stop = this.options.io.follow(threadId, (stream, chunk) =>
        this.feed(threadId, stream, chunk),
      );
      thread = watched;
    }
    this.start();
    // A scan already in flight may have started before this thread was watched.
    for (let attempt = 0; attempt < 2 && !thread.scanned && !this.closed; attempt++)
      await this.refresh();
    return thread.suggestions;
  }

  /** The thread's last known suggestions (empty while nobody watches it). */
  suggestions(threadId: ThreadId): PreviewSuggestion[] {
    return this.threads.get(threadId)?.suggestions ?? [];
  }

  /** A connection went away: its leases end now. */
  release(session: string): void {
    this.leases.delete(session);
    this.prune();
  }

  close(): void {
    this.closed = true;
    this.leases.clear();
    this.prune();
  }

  private feed(threadId: ThreadId, stream: string, chunk: string): void {
    if (!this.threads.has(threadId)) return;
    try {
      if (this.printed.feed(threadId, stream, chunk, this.options.now()).length) this.nudge?.();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /** Drop expired leases and stop following threads nobody holds. */
  private prune(): void {
    const now = this.options.now();
    const held = new Set<ThreadId>();
    for (const [session, threads] of this.leases) {
      for (const [threadId, lease] of threads)
        if (lease.until <= now) threads.delete(threadId);
        else held.add(threadId);
      if (!threads.size) this.leases.delete(session);
    }
    for (const [threadId, thread] of this.threads)
      if (!held.has(threadId)) {
        thread.stop();
        this.threads.delete(threadId);
        this.printed.forget(threadId);
      }
    if (!this.threads.size) {
      this.loop?.abort();
      this.loop = undefined;
      this.pages.clear();
      this.cwdCache.clear();
    }
  }

  private start(): void {
    if (this.loop || this.closed) return;
    const loop = new AbortController();
    this.loop = loop;
    const wait = (milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const early = new AbortController();
        this.nudge = () => early.abort();
        this.options
          .wait(milliseconds, AbortSignal.any([signal, early.signal]))
          .then(resolve, () => resolve());
      });
    void pollPorts<string>({
      signal: loop.signal,
      scan: async () => {
        await this.refresh();
        return new Set([...this.threads.values()].map((thread) => thread.fingerprint));
      },
      onChange: noop,
      onError: (error) => this.options.onError?.(error),
      wait,
      minDelay: this.options.minDelay ?? 1000,
      maxDelay: this.options.maxDelay ?? 4000,
      hurry: () => this.printed.waiting(),
    }).catch((error: unknown) => this.options.onError?.(error));
  }

  /** One scan at a time; callers arriving meanwhile share it. */
  private refresh(): Promise<void> {
    this.scanning ??= this.scan()
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        this.scanning = undefined;
      });
    return this.scanning;
  }

  private async scan(): Promise<void> {
    this.prune();
    const watched = [...this.threads.keys()];
    if (!watched.length) return;
    const { io } = this.options;
    const [listeners, parents, scopes] = await Promise.all([
      io.listeners(),
      io.parents(),
      Promise.all(watched.map((threadId) => io.scope(threadId))),
    ]);
    const facts = {
      listeners,
      parents,
      scopes: scopes.filter((scope) => scope !== undefined),
      daemon: this.options.daemon,
      daemonPorts: this.options.daemonPorts(),
    };
    const live = new Set(listeners.map((listener) => listener.pid));
    for (const pid of this.cwdCache.keys()) if (!live.has(pid)) this.cwdCache.delete(pid);
    const unknown = unexplainedPids(facts).filter((pid) => !this.cwdCache.has(pid));
    for (const [pid, cwd] of await io.cwds(unknown)) this.cwdCache.set(pid, cwd);
    const scoped = scopeListeners({ ...facts, cwds: this.cwdCache });
    const reachable = listeners.filter((listener) => listener.reach !== "other");
    this.printed.observe(new Set(reachable.map((listener) => listener.port)), this.options.now());
    const keys = new Set(reachable.map(pageKey));
    for (const key of this.pages.keys()) if (!keys.has(key)) this.pages.delete(key);
    await this.probe([...scoped.values()].flat());
    for (const threadId of watched) {
      const thread = this.threads.get(threadId);
      if (!thread) continue;
      thread.scanned = true;
      this.publish(threadId, thread, scoped.get(threadId) ?? []);
    }
  }

  /** Look at listeners not yet known to answer HTTP, a few per scan. */
  private async probe(listeners: readonly Listener[]): Promise<void> {
    const due = new Map<string, Listener>();
    for (const listener of listeners) {
      const key = pageKey(listener);
      const page = this.pages.get(key) ?? { facts: undefined, failures: 0, probing: false };
      this.pages.set(key, page);
      if (!page.facts && !page.probing && page.failures < maxFailures) due.set(key, listener);
    }
    await Promise.all(
      [...due].slice(0, probesPerScan).map(async ([key, listener]) => {
        const page = this.pages.get(key);
        if (!page) return;
        page.probing = true;
        try {
          const facts = await this.options.io.probe(listener.port);
          if (facts.http) page.facts = facts;
          else page.failures++;
        } catch {
          page.failures++;
        } finally {
          page.probing = false;
        }
      }),
    );
  }

  private publish(threadId: ThreadId, thread: Watched, listeners: readonly Listener[]): void {
    const suggestions: PreviewSuggestion[] = [];
    for (const listener of listeners) {
      const facts = this.pages.get(pageKey(listener))?.facts;
      if (!facts?.http) continue;
      const printed = this.printed.url(threadId, listener.port);
      suggestions.push({
        port: listener.port,
        url: printed ?? `http://localhost:${listener.port}/`,
        ...(facts.title ? { title: facts.title } : {}),
        ...(facts.iconUrl ? { iconUrl: facts.iconUrl } : {}),
        source: printed ? "terminal" : "listener",
      });
    }
    // Printed servers first (the one the person just started), then by port.
    suggestions.sort(
      (a, b) =>
        Number(b.source === "terminal") - Number(a.source === "terminal") || a.port - b.port,
    );
    const next = suggestions.slice(0, maxSuggestions);
    const fingerprint = JSON.stringify(next);
    if (fingerprint === thread.fingerprint) return;
    thread.suggestions = next;
    thread.fingerprint = fingerprint;
    for (const threads of this.leases.values()) {
      const lease = threads.get(threadId);
      if (!lease) continue;
      try {
        lease.push(next);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }
}

const pageKey = (listener: Listener) => `${listener.pid}:${listener.port}`;
const noop = () => {};
