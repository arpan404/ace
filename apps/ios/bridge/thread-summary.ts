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
import { readPersonAutomations, type PersonAutomations } from "./project-automations.ts";
import { summaryView, type SummaryPlan } from "./thread-summary-view.ts";

/*
 * The thread's Summary while its page is shown, as the web's Summary tab reads it: the thread's
 * live entities and those of every delegated thread its tree reaches (each held through an
 * optional lease, so it takes only spare room), the newest turn from the turn index (read again
 * as the thread moves on, at most every two seconds), the catch-up since this device's read
 * cursor, and the person's automations for the project's line (read again every minute, as the
 * web reads them). One coalesced patch carries it all; closing lets every lease and timer go.
 */

export type SummaryReads = Pick<
  ClientCore,
  "thread" | "threadRoom" | "turnsPage" | "threadCatchUp" | "threadReadState" | "request"
>;

export interface SummaryDeps {
  now(): number;
  /** The phone's IANA zone, so the next start reads on its clock. */
  zone(): string;
  scheduler: Scheduler;
  /** The catch-up cursor the person cleared, by thread, kept while the app runs. */
  cleared: Map<string, number>;
}

const key = "thread:summary";
/** At most one read of the newest turn this often while the thread's events stream in. */
const turnEveryMs = 2_000;
/** The daemon publishes no automation changes: they are read again this often while shown. */
const automationsEveryMs = 60_000;

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
  /** The person's folds of the tree's rows, kept while the page shows. */
  readonly #folds = new Map<string, boolean>();
  #automations: PersonAutomations | undefined;
  #automationsRead = 0;
  #automationsWait: (() => void) | undefined;
  #tick: (() => void) | undefined;
  #closed = false;
  /** The spare room last tried at: one try per rise, cleared once room runs out. */
  #triedRoom: number | undefined;
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
    const room = reads.threadRoom();
    this.#stops.push(room.subscribe(() => this.#roomChanged(room.getSnapshot())));
    this.#readTurn();
    void this.#readCatchUp();
    void this.#readAutomations();
    this.#put();
  }

  /** Read the person's automations again: the line's retry after a failed read. */
  automations(): void {
    void this.#readAutomations();
  }

  /** Clear: Since you looked goes, until the thread moves on past this cursor. */
  dismiss(): void {
    if (this.#catchUp) this.#deps.cleared.set(this.#threadId, this.#catchUp.since);
    this.#put();
  }

  /** Open or fold one of the tree's rows, or its "N done" line. */
  fold(rowKey: string, open: boolean): void {
    this.#folds.set(rowKey, open);
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
    this.#automationsWait?.();
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

  /** The person's automations now, and again a minute after each read while the page shows. */
  async #readAutomations(): Promise<void> {
    if (this.#closed) return;
    this.#automationsWait?.();
    const read = ++this.#automationsRead;
    const automations = await readPersonAutomations(this.#reads);
    if (this.#closed || read !== this.#automationsRead) return;
    this.#automations = automations;
    this.#automationsWait = this.#deps.scheduler.set(automationsEveryMs, () => {
      this.#automationsWait = undefined;
      void this.#readAutomations();
    });
    this.#put();
  }

  /**
   * Room for optional threads changed. A delegated thread refused for room, or one that gave its
   * room to a thread the person opened, is held again when room frees: once per rise, as the
   * web's Summary does, so a thread refused again waits for the next one.
   */
  #roomChanged(room: number): void {
    if (this.#closed) return;
    if (room <= 0) {
      this.#triedRoom = undefined;
      return;
    }
    if (this.#triedRoom === room) return;
    const refused = [...this.#held].filter(
      ([, held]) => held.lease.store.error?.code === "no_room",
    );
    if (!refused.length) return;
    this.#triedRoom = room;
    for (const [id, held] of refused) {
      held.stop();
      held.lease.release();
      this.#held.delete(id);
      this.#works.delete(id);
    }
    this.#forest = this.#join();
    this.#put();
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

  /** The store of a thread the tree holds: the open thread's own, or a delegated one's. */
  #storeOf(threadId: string): ThreadSource | undefined {
    return threadId === this.#threadId ? this.#store : this.#held.get(threadId)?.lease.store;
  }

  #name(threadId: string, agent: Agent): string {
    const store = this.#storeOf(threadId);
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
          folds: this.#folds,
          automations: this.#automations,
          zone: this.#deps.zone(),
          now,
          name: (threadId, agent) => this.#name(threadId, agent),
          agent: (id) => this.#store.agent(id),
          item: (id) => this.#store.item(id),
          treeItem: (threadId, id) => this.#storeOf(threadId)?.item(id),
        },
        this.#preview,
      );
      const counting = summary.now.span !== null && summary.now.lead === "Working";
      const since = this.#turn?.startedAt;
      this.#schedule(
        [
          ...(counting && since !== undefined ? [since] : []),
          ...(summary.agents?.lines ?? []).flatMap((line) =>
            line.kind !== "finished" && line.since !== null ? [line.since] : [],
          ),
        ],
        now,
      );
      return {
        type: "thread.summary",
        threadId: this.#threadId,
        epoch: this.#epoch,
        sheet: summary,
      };
    });
  }

  /**
   * While Now or a tree row counts time, say it again when the soonest shown time next changes:
   * each second under a minute, then each minute.
   */
  #schedule(starts: readonly number[], now: number): void {
    this.#tick?.();
    this.#tick = undefined;
    if (!starts.length) return;
    const delay = Math.min(
      ...starts.map((since) => {
        const elapsed = Math.max(0, now - since);
        return elapsed < 60_000 ? 1_000 - (elapsed % 1_000) : 60_000 - (elapsed % 60_000);
      }),
    );
    this.#tick = this.#deps.scheduler.set(delay + 20, () => {
      this.#tick = undefined;
      this.#put();
    });
  }
}
