import type { ThreadReader } from "@ace/client";
import type { Interaction, Item, Run } from "@ace/protocol";
import { rootRunOf } from "./turn-ordinals.ts";

/*
 * One incremental projection per thread reader, shared by every transcript selector: the spans
 * the agents waited on a person, the requests still open, the inline questions, the calls that
 * became background tasks, the steps still in flight, and the current stretch of work. Each
 * `sync` costs what changed: appended (or prepended) items, new interactions and tasks, and a
 * re-check of the few entries still open, found by object identity (stores replace an entity's
 * object when it changes). A window that no longer extends the last one is rebuilt once.
 */

export type LedgerReader = Pick<
  ThreadReader,
  | "order"
  | "item"
  | "run"
  | "agent"
  | "thread"
  | "interactionIds"
  | "interaction"
  | "taskIds"
  | "task"
>;

/** One span the agents spent waiting on a person: from the request to its answer. */
export interface WaitSpan {
  from: number;
  /** Undefined while still waiting. */
  to: number | undefined;
}

/** An interaction shown in the transcript where it was asked. */
export interface InlineQuestion {
  id: string;
  toolCallId: string | undefined;
  createdAt: number;
}

const inFlightStatus = new Set(["pending", "running", "awaiting_approval"]);
const runningStatus = new Set(["pending", "running"]);

/** Interactions shown as their own transcript block where they were asked. */
const inlineKinds = new Set<Interaction["request"]["kind"]>(["question"]);

export function isInlineInteraction(interaction: Pick<Interaction, "request">): boolean {
  return inlineKinds.has(interaction.request.kind);
}

/** Requests that held the agent until a person answered (not ace's own auto-review). */
function waitsOnPerson(interaction: Interaction): boolean {
  return interaction.blocking && interaction.autoReviewed !== true;
}

/**
 * Whether an item ends the stretch of work before it: the person's own message. A turn is one
 * stretch: what the agent says between steps, and questions it asks, stay inside it (time spent
 * waiting on the person is left out of the timer), so its "Worked for" log is one per turn.
 */
export function closesStretch(item: Item): boolean {
  return item.type === "message" && item.role === "user" && !item.synthetic;
}

const carryingOn = new Set<Run["trigger"]>(["background_completion", "subagent_result"]);

/**
 * Whether a run carries on the stretch before it: the agent started it by itself once its
 * background work or a subagent finished, so no one asked and no new stretch begins.
 */
export function carriesOnStretch(trigger: Run["trigger"] | undefined): boolean {
  return trigger !== undefined && carryingOn.has(trigger);
}

/** Whether an item counts as the stretch's work (what a "Worked for" log times). */
function isWork(item: Item): boolean {
  if (item.type === "message" || item.type === "compaction" || item.type === "artifact")
    return false;
  return !(item.type === "tool_call" && item.call.detail.kind === "agent.spawn");
}

const startOf = (item: Item) =>
  item.type === "tool_call" ? Math.min(item.createdAt, item.call.startedAt) : item.createdAt;

/**
 * How many of a stretch's earliest steps it remembers, to find its start again should one of
 * them turn out to be a background call. A turn can run for days, so the stretch keeps these
 * few, never all of its work.
 */
const earliestKept = 16;

interface Stretch {
  /** The root turn it belongs to. */
  run: string | undefined;
  /** Its earliest steps by start, at most `earliestKept`, oldest first. */
  earliest: { id: string; start: number }[];
  start: number | undefined;
  /** Its steps that were in flight when they arrived (pruned as they settle). */
  flying: Set<string>;
  /** The background calls its start leaves out. */
  tasksVersion: number;
  /** Time the agent sat idle between runs that carried the stretch on. */
  idle: number;
}

function newStretch(run: string | undefined): Stretch {
  return { run, earliest: [], start: undefined, flying: new Set(), tasksVersion: -1, idle: 0 };
}

export class ThreadLedger {
  // Interactions, processed in the store's insertion order.
  private interactionCount = 0;
  private lastInteraction: string | undefined;
  /** Open requests, by id, with the object last seen (a new object means it changed). */
  private readonly openRequests = new Map<string, Interaction>();
  private readonly spanOf = new Map<string, WaitSpan>();
  /** The waits still open (few), so a query never walks the closed ones. */
  private readonly openWaits = new Map<string, WaitSpan>();
  /** Closed waits merged into disjoint, ordered intervals, with the covered time before each. */
  private merged: { from: number; to: number; before: number }[] = [];
  private mergedDirty = false;
  private readonly inline: InlineQuestion[] = [];
  /** Bumped when the inline questions, open requests or waits change. */
  interactionsVersion = 0;

  // Background tasks.
  private taskCount = 0;
  private lastTask: string | undefined;
  /** Tool call → background task, for calls that outlived their turn (not ambient helpers). */
  readonly background = new Map<string, string>();
  /** Every call that became a background task, ambient or not. */
  private readonly backgroundCalls = new Set<string>();
  tasksVersion = 0;

  // Items.
  private order: readonly string[] | undefined;
  private firstId: string | undefined;
  private lastId: string | undefined;
  /** Tool calls still in flight anywhere in the window, with the object last seen. */
  private readonly flying = new Map<string, Item>();
  private stretch = newStretch(undefined);

  /** Bring the ledger up to date with the reader. Costs what changed since the last call. */
  sync(reader: LedgerReader): this {
    this.syncInteractions(reader);
    this.syncTasks(reader);
    this.syncOrder(reader);
    return this;
  }

  private resetInteractions() {
    this.interactionCount = 0;
    this.lastInteraction = undefined;
    this.openRequests.clear();
    this.spanOf.clear();
    this.openWaits.clear();
    this.merged = [];
    this.inline.length = 0;
    this.mergedDirty = false;
  }

  private syncInteractions(reader: LedgerReader) {
    const ids = reader.interactionIds();
    const count = this.interactionCount;
    if (ids.length < count || (count > 0 && ids[count - 1] !== this.lastInteraction)) {
      this.resetInteractions();
      this.interactionsVersion++;
    }
    for (let index = this.interactionCount; index < ids.length; index++) {
      const interaction = reader.interaction(ids[index] ?? "");
      if (interaction) this.addInteraction(interaction);
    }
    this.interactionCount = ids.length;
    this.lastInteraction = ids.at(-1);
    for (const [id, seen] of this.openRequests) {
      const now = reader.interaction(id);
      if (now !== seen) this.updateInteraction(id, now);
    }
    if (this.mergedDirty) this.merge();
  }

  private addInteraction(interaction: Interaction) {
    this.interactionsVersion++;
    if (isInlineInteraction(interaction))
      this.inline.push({
        id: interaction.id,
        toolCallId: interaction.toolCallId,
        createdAt: interaction.createdAt,
      });
    if (interaction.state === "pending") this.openRequests.set(interaction.id, interaction);
    if (waitsOnPerson(interaction)) {
      const span = { from: interaction.createdAt, to: interaction.closedAt };
      this.spanOf.set(interaction.id, span);
      if (span.to === undefined) this.openWaits.set(interaction.id, span);
      else this.mergedDirty = true;
    }
  }

  private updateInteraction(id: string, interaction: Interaction | undefined) {
    this.interactionsVersion++;
    if (!interaction || interaction.state !== "pending") this.openRequests.delete(id);
    else this.openRequests.set(id, interaction);
    const span = this.spanOf.get(id);
    if (!span) return;
    if (!interaction || !waitsOnPerson(interaction)) this.spanOf.delete(id);
    else span.to = interaction.closedAt;
    if (span.to !== undefined || !this.spanOf.has(id)) this.openWaits.delete(id);
    this.mergedDirty = true;
  }

  /** Rebuild the merged closed waits: once per closed request, shared by every reader. */
  private merge() {
    const closed = [...this.spanOf.values()]
      .filter((span): span is { from: number; to: number } => span.to !== undefined)
      .toSorted((a, b) => a.from - b.from);
    const merged: { from: number; to: number; before: number }[] = [];
    let covered = 0;
    for (const span of closed) {
      const last = merged.at(-1);
      if (last && span.from <= last.to) {
        if (span.to > last.to) {
          covered += span.to - last.to;
          last.to = span.to;
        }
        continue;
      }
      merged.push({ from: span.from, to: span.to, before: covered });
      covered += span.to - span.from;
    }
    this.merged = merged;
    this.mergedDirty = false;
  }

  /** Closed waiting time before `at`. O(log n). */
  private coveredBefore(at: number): number {
    const merged = this.merged;
    let low = 0;
    let high = merged.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((merged[middle]?.from ?? 0) < at) low = middle + 1;
      else high = middle;
    }
    const span = merged[low - 1];
    if (!span) return 0;
    return span.before + Math.min(at, span.to) - span.from;
  }

  /**
   * How much of [from, to] the agents spent waiting on a person. Closed waits are counted once
   * however they overlap; a still-open wait counts up to `now`.
   */
  waitedWithin(from: number, to: number, now = to): number {
    if (to <= from) return 0;
    let total = this.coveredBefore(to) - this.coveredBefore(from);
    for (const span of this.openWaits.values())
      total += Math.max(0, Math.min(now, to) - Math.max(span.from, from));
    return Math.min(total, to - from);
  }

  /** Requests still waiting on the person. */
  pending(): IterableIterator<Interaction> {
    return this.openRequests.values();
  }

  isPending(interactionId: string): boolean {
    return this.openRequests.has(interactionId);
  }

  /** Interactions shown inline where they were asked, oldest first. */
  questions(): readonly InlineQuestion[] {
    return this.inline;
  }

  private syncTasks(reader: LedgerReader) {
    const ids = reader.taskIds();
    const count = this.taskCount;
    if (ids.length < count || (count > 0 && ids[count - 1] !== this.lastTask)) {
      this.taskCount = 0;
      this.background.clear();
      this.backgroundCalls.clear();
      this.tasksVersion++;
    }
    for (let index = this.taskCount; index < ids.length; index++) {
      const task = reader.task(ids[index] ?? "");
      if (!task?.toolCallId) continue;
      this.backgroundCalls.add(task.toolCallId);
      if (!task.ambient) this.background.set(task.toolCallId, task.id);
      this.tasksVersion++;
    }
    this.taskCount = ids.length;
    this.lastTask = ids.at(-1);
  }

  private resetOrder() {
    this.order = undefined;
    this.firstId = undefined;
    this.lastId = undefined;
    this.flying.clear();
    this.stretch = newStretch(undefined);
  }

  private syncOrder(reader: LedgerReader) {
    const order = reader.order;
    if (order === this.order) {
      this.recheckFlying(reader);
      return;
    }
    let from = 0;
    if (this.lastId !== undefined) {
      const last = order.lastIndexOf(this.lastId);
      if (last < 0) this.resetOrder();
      else {
        from = last + 1;
        // Older history paged in before the window's first item: only its steps in flight.
        if (order[0] !== this.firstId) {
          const first = this.firstId === undefined ? -1 : order.indexOf(this.firstId);
          if (first < 0) {
            this.resetOrder();
            from = 0;
          } else for (let index = 0; index < first; index++) this.track(reader, order[index]);
        }
      }
    }
    for (let index = from; index < order.length; index++) this.append(reader, order[index]);
    this.order = order;
    this.firstId = order[0];
    this.lastId = order.at(-1);
    this.recheckFlying(reader);
  }

  private track(reader: LedgerReader, id: string | undefined) {
    const item = id === undefined ? undefined : reader.item(id);
    if (item?.type === "tool_call" && inFlightStatus.has(item.call.status))
      this.flying.set(item.id, item);
  }

  private append(reader: LedgerReader, id: string | undefined) {
    const item = id === undefined ? undefined : reader.item(id);
    if (!item) return;
    this.track(reader, id);
    if (closesStretch(item)) {
      this.stretch = newStretch(undefined);
      return;
    }
    const run = rootRunOf(reader, item.runId)?.id;
    const before = this.stretch.run;
    if (run !== undefined && before !== undefined && run !== before) {
      const next = reader.run(run);
      if (carriesOnStretch(next?.trigger)) {
        const ended = reader.run(before)?.endedAt;
        if (ended !== undefined && next && next.startedAt > ended)
          this.stretch.idle += next.startedAt - ended;
        this.stretch.run = run;
      } else this.stretch = newStretch(run);
    } else if (run !== undefined) this.stretch.run = run;
    if (!isWork(item)) return;
    const stretch = this.stretch;
    const start = startOf(item);
    const earliest = stretch.earliest;
    if (earliest.length < earliestKept || start < (earliest.at(-1)?.start ?? 0)) {
      let at = earliest.length;
      while (at > 0 && (earliest[at - 1]?.start ?? 0) > start) at--;
      earliest.splice(at, 0, { id: item.id, start });
      if (earliest.length > earliestKept) earliest.pop();
    }
    if (!this.backgroundCalls.has(item.id))
      stretch.start = Math.min(stretch.start ?? Number.POSITIVE_INFINITY, start);
    if (this.flying.has(item.id)) stretch.flying.add(item.id);
  }

  private recheckFlying(reader: LedgerReader) {
    for (const [id, seen] of this.flying) {
      const now = reader.item(id);
      if (now === seen) continue;
      if (now?.type === "tool_call" && inFlightStatus.has(now.call.status))
        this.flying.set(id, now);
      else this.flying.delete(id);
    }
  }

  /** Tool calls still in flight (or awaiting approval) in the loaded window. */
  inFlight(): IterableIterator<string> {
    return this.flying.keys();
  }

  /**
   * The current stretch of work: when it started, the newest step still running in it, and the
   * items whose changes can move either (to subscribe to). Calls that became background tasks
   * are not the stretch's work.
   */
  currentStretch(reader: LedgerReader): {
    start: number | undefined;
    /** Time the agent sat idle between runs that carried the stretch on. */
    idle: number;
    current: Item | undefined;
    watch: string[];
  } {
    const stretch = this.stretch;
    // A call of the stretch became a background task: time the stretch without it (rare). Its
    // earliest steps that stayed in the foreground say when it started.
    if (stretch.tasksVersion !== this.tasksVersion) {
      stretch.tasksVersion = this.tasksVersion;
      const first = stretch.earliest.find((step) => !this.backgroundCalls.has(step.id));
      // While it holds every step, none left in the foreground means no work to time yet.
      if (first) stretch.start = first.start;
      else if (stretch.earliest.length < earliestKept) stretch.start = undefined;
    }
    let current: Item | undefined;
    const watch: string[] = [];
    for (const id of stretch.flying) {
      if (!this.flying.has(id)) {
        stretch.flying.delete(id);
        continue;
      }
      if (this.backgroundCalls.has(id)) continue;
      watch.push(id);
      const item = reader.item(id);
      if (item?.type === "tool_call" && runningStatus.has(item.call.status)) current = item;
    }
    return { start: stretch.start, idle: stretch.idle, current, watch };
  }
}

const ledgers = new WeakMap<object, ThreadLedger>();

/** The reader's shared ledger, brought up to date. */
export function ledgerOf(reader: LedgerReader): ThreadLedger {
  let ledger = ledgers.get(reader);
  if (!ledger) ledgers.set(reader, (ledger = new ThreadLedger()));
  return ledger.sync(reader);
}
