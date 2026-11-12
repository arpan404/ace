import type { ChangeTap, ClientCore, Lease, Scheduler, ThreadSource } from "@ace/client";
import type { Agent, ThreadCatchUpResponse, TurnSummary } from "@ace/protocol";
import {
  agentForest,
  agentName,
  catchUpFacts,
  forestBounds,
  forestLayers,
  latestPlanSteps,
  planProgress,
  planShown,
  planTodos,
  type ThreadWork,
} from "@ace/ui-core";
import { touchesTree, type PatchSink, type Preview } from "./agents.ts";
import { summaryView, type SummaryPlan } from "./thread-summary-view.ts";

/*
 * The thread's Summary while its page is shown, as the web's Summary tab reads it: the thread's
 * live entities and those of every delegated thread its tree reaches (each held through an
 * optional lease, so it takes only spare room), the newest turn from the turn index (read again
 * as the thread moves on, at most every two seconds), and the catch-up since this device's read
 * cursor. One coalesced patch carries it all; closing lets every lease and timer go.
 */

export type SummaryReads = Pick<
  ClientCore,
  "thread" | "turnsPage" | "threadCatchUp" | "threadReadState"
>;

export interface SummaryDeps {
  now(): number;
  scheduler: Scheduler;
  /** The catch-up cursor the person cleared, by thread, kept while the app runs. */
  cleared: Map<string, number>;
}

const key = "thread:summary";
/** At most one read of the newest turn this often while the thread's events stream in. */
const turnEveryMs = 2_000;

const present = <T>(value: T | undefined): value is T => value !== undefined;

/** One thread's live entities and how current they are, as the forest reads them. */
function workOf(store: ThreadSource): ThreadWork {
  if (store.error) return { agents: [], tasks: [], interactions: [], facts: "not_loaded" };
  return {
    agents: store
      .agentIds()
      .map((id) => store.agent(id))
      .filter(present),
    tasks: store
      .taskIds()
      .map((id) => store.task(id))
      .filter(present),
    interactions: store
      .interactionIds()
      .map((id) => store.interaction(id))
      .filter((interaction) => interaction?.state === "pending")
      .filter(present),
    status: store.thread?.status,
    facts: !store.thread || store.syncing || store.unconfirmed ? "syncing" : "live",
  };
}

/** Only these change a thread's own part of the tree; transcript deltas never do. */
const reshapes = (keys: ReadonlySet<string> | "all") =>
  keys === "all" || touchesTree(keys) || keys.has("error");

export class ThreadSummary {
  readonly #reads: SummaryReads;
  readonly #store: ThreadSource;
  readonly #threadId: string;
  readonly #epoch: number;
  readonly #sink: PatchSink;
  readonly #preview: Preview;
  readonly #deps: SummaryDeps;
  readonly #layers = forestLayers();
  readonly #stops: (() => void)[] = [];
  /** Delegated threads the tree reaches, held while it does. */
  readonly #held = new Map<string, { lease: Lease<ThreadSource>; stop(): void }>();
  readonly #works = new Map<string, ThreadWork>();
  #turn: TurnSummary | undefined;
  #turnRead = 0;
  #turnWait: (() => void) | undefined;
  #turnAgain = false;
  #catchUp: { since: number; reply: ThreadCatchUpResponse } | undefined;
  #showClosed = false;
  #tick: (() => void) | undefined;
  #closed = false;
  /** Plan items and runs shown, whose updates re-read the plan. */
  #planKeys = new Set<string>();
  #forest: ReturnType<typeof agentForest>;

  constructor(
    reads: SummaryReads,
    store: ThreadSource,
    threadId: string,
    epoch: number,
    sink: PatchSink,
    preview: Preview,
    deps: SummaryDeps,
  ) {
    this.#reads = reads;
    this.#store = store;
    this.#threadId = threadId;
    this.#epoch = epoch;
    this.#sink = sink;
    this.#preview = preview;
    this.#deps = deps;
    this.#works.set(threadId, workOf(store));
    this.#forest = this.#join();
    const tap: ChangeTap = (keys) => {
      if (reshapes(keys)) {
        this.#works.set(threadId, workOf(store));
        this.#forest = this.#join();
      }
      if (keys === "all" || keys.has("cursor")) this.#readTurn();
      if (keys === "all" || reshapes(keys) || keys.has("order") || this.#plansMoved(keys))
        this.#put();
    };
    this.#stops.push(store.observe(tap));
    this.#readTurn();
    void this.#readCatchUp();
    this.#put();
  }

  /** Clear: Since you looked goes, until the thread moves on past this cursor. */
  dismiss(): void {
    if (this.#catchUp) this.#deps.cleared.set(this.#threadId, this.#catchUp.since);
    this.#put();
  }

  /** Show or hide the closed pull requests folded under one line. */
  closedPrs(shown: boolean): void {
    this.#showClosed = shown;
    this.#put();
  }

  close(): void {
    this.#closed = true;
    for (const stop of this.#stops.splice(0)) stop();
    for (const held of this.#held.values()) {
      held.stop();
      held.lease.release();
    }
    this.#held.clear();
    this.#turnWait?.();
    this.#tick?.();
    this.#sink.clear(key);
  }

  #plansMoved(keys: ReadonlySet<string>): boolean {
    for (const changed of this.#planKeys) if (keys.has(changed)) return true;
    return false;
  }

  /** The newest turn, read now and then at most once per period while the cursor moves. */
  #readTurn(): void {
    if (this.#closed) return;
    if (this.#turnWait) {
      this.#turnAgain = true;
      return;
    }
    const read = ++this.#turnRead;
    this.#reads.turnsPage({ threadId: this.#threadId, limit: 1 }).then(
      (page) => {
        if (this.#closed || read !== this.#turnRead) return;
        this.#turn = page.turns.at(-1);
        this.#put();
      },
      // The last summary stays on screen; the next cursor move reads again.
      () => {},
    );
    this.#turnWait = this.#deps.scheduler.set(turnEveryMs, () => {
      this.#turnWait = undefined;
      if (!this.#turnAgain) return;
      this.#turnAgain = false;
      this.#readTurn();
    });
  }

  /** What happened since this device's read cursor; a thread never read here has none. */
  async #readCatchUp(): Promise<void> {
    try {
      const state = await this.#reads.threadReadState({ threadId: this.#threadId });
      const since = state.lastSeenSeq;
      if (this.#closed || since <= 0) return;
      const reply = await this.#reads.threadCatchUp({ threadId: this.#threadId, sinceSeq: since });
      if (this.#closed) return;
      this.#catchUp = { since, reply };
      this.#put();
    } catch {
      // No catch-up is said rather than a wrong one.
    }
  }

  /**
   * The tree across threads, holding what it reaches. A thread just held may already have its
   * facts (another view reads it), and those may reach a thread further down, so it joins and
   * holds again until nothing new is reached: at most once per level the forest follows.
   */
  #join(): ReturnType<typeof agentForest> {
    let forest = agentForest(this.#threadId, this.#works, undefined, this.#layers);
    for (let level = 0; level < forestBounds.depth && this.#hold(forest.reach); level++)
      forest = agentForest(this.#threadId, this.#works, undefined, this.#layers);
    return forest;
  }

  /**
   * Hold every delegated thread the tree reaches now, and let go of those it no longer does.
   * True when it took a new one.
   */
  #hold(reach: readonly string[]): boolean {
    let took = false;
    const wanted = new Set(reach);
    for (const [id, held] of this.#held)
      if (!wanted.has(id)) {
        held.stop();
        held.lease.release();
        this.#held.delete(id);
        this.#works.delete(id);
      }
    for (const id of reach) {
      if (this.#held.has(id) || id === this.#threadId) continue;
      const lease = this.#reads.thread(id, { optional: true });
      const stop = lease.store.observe((keys) => {
        if (!reshapes(keys) || this.#held.get(id)?.lease !== lease) return;
        this.#works.set(id, workOf(lease.store));
        this.#forest = this.#join();
        this.#put();
      });
      this.#held.set(id, { lease, stop });
      this.#works.set(id, workOf(lease.store));
      took = true;
    }
    return took;
  }

  #plans(): SummaryPlan[] {
    const store = this.#store;
    const steps = latestPlanSteps(store);
    this.#planKeys = new Set(
      steps.flatMap((step) => [
        `item:${step.itemId}`,
        ...(step.runId ? [`run:${step.runId}`] : []),
      ]),
    );
    return steps.flatMap((step) => {
      const item = store.item(step.itemId);
      const run = step.runId ? store.run(step.runId) : undefined;
      const progress = planProgress(
        planTodos(item?.type === "tool_call" ? item.call.detail : undefined),
      );
      return planShown(progress, run ? run.state !== "active" : true)
        ? [{ agentId: step.agentId, todos: progress.todos }]
        : [];
    });
  }

  #name(threadId: string, agent: Agent): string {
    const store = threadId === this.#threadId ? this.#store : this.#held.get(threadId)?.lease.store;
    return agentName(agent, agent.spawnedBy ? store?.item(agent.spawnedBy) : undefined);
  }

  #put(): void {
    if (this.#closed) return;
    this.#sink.put(key, () => {
      const thread = this.#store.thread;
      if (!thread) return undefined;
      const forest = this.#forest;
      const now = this.#deps.now();
      const caught = this.#catchUp;
      const shown =
        caught &&
        this.#deps.cleared.get(this.#threadId) !== caught.since &&
        catchUpFacts(caught.reply).length > 0
          ? caught.reply
          : undefined;
      const summary = summaryView(
        {
          threadId: this.#threadId,
          thread,
          forest,
          works: this.#works,
          turn: this.#turn,
          catchUp: shown,
          plans: this.#plans(),
          showClosed: this.#showClosed,
          now,
          name: (threadId, agent) => this.#name(threadId, agent),
          agent: (id) => this.#store.agent(id),
          item: (id) => this.#store.item(id),
        },
        this.#preview,
      );
      this.#schedule(summary.now.span !== null && summary.now.lead === "Working", now);
      return {
        type: "thread.summary",
        threadId: this.#threadId,
        epoch: this.#epoch,
        sheet: summary,
      };
    });
  }

  /** While Now counts the turn's time, say it again when the shown time next changes. */
  #schedule(counting: boolean, now: number): void {
    this.#tick?.();
    this.#tick = undefined;
    const since = this.#turn?.startedAt;
    if (!counting || since === undefined) return;
    const elapsed = Math.max(0, now - since);
    const delay = elapsed < 60_000 ? 1_000 - (elapsed % 1_000) : 60_000 - (elapsed % 60_000);
    this.#tick = this.#deps.scheduler.set(delay + 20, () => {
      this.#tick = undefined;
      this.#put();
    });
  }
}
