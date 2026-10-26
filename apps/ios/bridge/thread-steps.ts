import type { ChangeTap, ClientCore, ThreadSource } from "@ace/client";
import { TurnStepsCache, type TurnStepsEntry } from "@ace/client/turn-steps";
import type { Item, ThreadId } from "@ace/protocol";
import { rootRunOf } from "@ace/ui-core";
import { scheduler } from "./host.ts";
import { backgroundRows } from "./background-rows.ts";
import { itemRow, preview } from "./presentation.ts";
import { logFacts } from "./thread-blocks.ts";
import { itemDetail, stepContext } from "./thread-rows.ts";
import { turnThoughtMs, turnThoughts } from "./thread-messages.ts";
import { workLog } from "./work-log.ts";

/*
 * A finished turn's full steps, read from the daemon (`turn.steps`, the SDK's bounded cache) while
 * its "Worked for" head is on the phone's screen (open or about to be), and released when it
 * leaves: a long thread never holds every finished step. Steps go to Swift in fixed pages, each its
 * own patch, so a long turn never travels as one frame. Swift keeps the rows of the last
 * `keptLimit` turns it was sent, open or not; the follower remembers what it sent them, so a log
 * opened again, or scrolled back into view, shows at once and sends nothing that has not changed.
 * A turn pushed out of that bound is released on both sides. The root agent's own steps only, as the web shows them; the answer under the head
 * stays out. A turn that changes while its log is open (a late result landing in it) is read
 * again: its summary's `endSeq` (`turns.page`) tells the cache whether what it holds is older,
 * as the web passes it.
 */

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;
const pageSize = 25;
/** Turns one phone holds open together; opening another closes the oldest. */
const openLimit = 4;
/** Turns whose rows Swift keeps, open or recently open; the oldest closed one goes beyond it. */
const keptLimit = 8;

interface Slot {
  /** The hold on the turn while it is open; undefined once closed. */
  release: (() => void) | undefined;
  answers: ReadonlySet<string>;
  entry: TurnStepsEntry | undefined;
  /** Its header goes with the next send even if its steps did not change (it opened again). */
  fresh: boolean;
  /** Pages delivered for `entry`, by their first step's id and length. */
  pages: string[];
  /** A summary read is under way; `again` asks for one more when it lands. */
  checking: boolean;
  again: boolean;
}

function stepRow(store: ThreadSource, item: Parameters<typeof itemRow>[0], thought: string | null) {
  const row = { ...itemRow(item), ...itemDetail(item, stepContext(store, item)), thought };
  // Steps read as one line each; a long thought or command keeps a bounded head.
  return { ...row, text: preview(row.text, 1024) };
}

export class StepsFollower {
  readonly #client: Pick<ClientCore, "turnsPage">;
  readonly #cache: TurnStepsCache;
  readonly #store: ThreadSource;
  readonly #threadId: ThreadId;
  readonly #put: Put;
  /** Turns Swift keeps rows for, oldest use first. */
  readonly #slots = new Map<number, Slot>();
  readonly #stop: () => void;

  constructor(client: ClientCore, store: ThreadSource, threadId: ThreadId, put: Put) {
    this.#client = client;
    this.#cache = new TurnStepsCache({
      read: (input, options) => client.request(input, options),
      maxSteps: 2000,
      maxTurnSteps: 500,
      // JavaScriptCore has no timers of its own; the host's run loop keeps the grace period.
      schedule: (run, ms) => scheduler.set(ms, run),
    });
    this.#store = store;
    this.#threadId = threadId;
    this.#put = put;
    this.#stop = this.#cache.subscribe(() => {
      for (const [ordinal, slot] of this.#slots) if (slot.release) this.#emit(ordinal);
    });
  }

  /**
   * A log opened or its head came into view: hold its turn and read it, or show what was read.
   * `answers` are the head's answer ids. Opening one already open does nothing.
   */
  open(ordinal: number, answers: readonly string[]): void {
    let slot = this.#slots.get(ordinal);
    if (slot?.release) return;
    if (slot) this.#slots.delete(ordinal);
    else
      slot = {
        release: undefined,
        answers: new Set(answers),
        entry: undefined,
        pages: [],
        fresh: true,
        checking: false,
        again: false,
      };
    this.#slots.set(ordinal, slot);
    const held = [...this.#slots].filter(([, other]) => other.release);
    if (held.length >= openLimit) this.close(held[0]?.[0] ?? ordinal);
    slot.release = this.#cache.retain(this.#threadId, ordinal);
    slot.fresh = true;
    this.#trim();
    this.#emit(ordinal);
    // A read held from before may predate the turn's end: its summary says.
    void this.#check(ordinal);
  }

  /** The thread changed: an open turn whose own items moved is checked against its summary. */
  readonly changed: ChangeTap = (keys) => {
    if (!this.#slots.size) return;
    if (keys === "all") {
      // A fresh snapshot may have cleared what Swift held: everything kept is sent again.
      for (const [ordinal, slot] of this.#slots) {
        slot.entry = undefined;
        slot.pages = [];
        if (slot.release) this.#emit(ordinal);
      }
      return;
    }
    const touched = new Set<number>();
    for (const key of keys) {
      if (!key.startsWith("item:")) continue;
      const item = this.#store.item(key.slice(5));
      const ordinal = rootRunOf(this.#store, item?.runId)?.ordinal;
      if (ordinal !== undefined && this.#slots.get(ordinal)?.release) touched.add(ordinal);
    }
    for (const ordinal of touched) void this.#check(ordinal);
  };

  /** A log's head left the screen: let its turn go. Swift keeps its rows within `keptLimit`. */
  close(ordinal: number): void {
    const slot = this.#slots.get(ordinal);
    if (!slot?.release) return;
    const release = slot.release;
    slot.release = undefined;
    release();
    this.#trim();
  }

  /** Read the next part of a turn longer than one read, or again after a failed read. */
  more(ordinal: number): void {
    const slot = this.#slots.get(ordinal);
    if (!slot?.release) return;
    const entry = this.#cache.get(this.#threadId, ordinal);
    if (entry?.state === "failed") this.#cache.retain(this.#threadId, ordinal)();
    else this.#cache.loadMore(this.#threadId, ordinal);
  }

  /** Read the turn's summary; when it ended after what the cache holds, read its steps again. */
  async #check(ordinal: number): Promise<void> {
    const slot = this.#slots.get(ordinal);
    if (!slot?.release) return;
    if (slot.checking) {
      slot.again = true;
      return;
    }
    slot.checking = true;
    try {
      do {
        slot.again = false;
        const page = await this.#client.turnsPage({
          threadId: this.#threadId,
          before: ordinal + 1,
          limit: 1,
        });
        const endSeq = page.turns.find((turn) => turn.ordinal === ordinal)?.endSeq;
        if (endSeq === undefined || this.#slots.get(ordinal) !== slot || !slot.release) return;
        // Holding the turn with its end reads it again only when the cache's copy is older.
        this.#cache.retain(this.#threadId, ordinal, endSeq)();
      } while (slot.again);
    } catch {
      // Offline or refused: the log keeps what it shows; reopening checks again.
    } finally {
      slot.checking = false;
    }
  }

  dispose(): void {
    this.#stop();
    for (const slot of this.#slots.values()) slot.release?.();
    this.#slots.clear();
    this.#cache.dropThread(this.#threadId);
  }

  /** Past `keptLimit`, the oldest closed turns go from Swift too. */
  #trim(): void {
    for (const [ordinal, slot] of this.#slots) {
      if (this.#slots.size <= keptLimit) return;
      if (slot.release) continue;
      this.#slots.delete(ordinal);
      for (let page = 0; page < slot.pages.length; page += 1)
        this.#put(`steps:${ordinal}:${page}`, () => undefined);
      this.#put(`steps:${ordinal}`, () => ({ type: "thread.stepsReleased", ordinal }));
    }
  }

  /** Send what changed in an open turn: its pages that changed, and its header. */
  #emit(ordinal: number): void {
    const slot = this.#slots.get(ordinal);
    if (!slot?.release) return;
    const entry = this.#cache.get(this.#threadId, ordinal);
    // Read again from nothing (its copy was let go): Swift keeps showing the rows it has.
    if (
      slot.pages.length > 0 &&
      (entry === undefined || (entry.state === "loading" && entry.steps.length === 0))
    )
      return;
    const changed = entry !== slot.entry;
    if (!changed && !slot.fresh) return;
    slot.fresh = false;
    const owner = this.#store.thread?.rootAgentId;
    const steps = (entry?.steps ?? []).filter(
      (step) =>
        (owner === undefined || step.item.agentId === owner) && !slot.answers.has(step.item.id),
    );
    // The daemon's copy of the turn times its thoughts; the live store may not hold them.
    const took = turnThoughtMs(
      this.#store,
      (entry?.steps ?? []).map((step) => step.item),
    );
    const thoughts = turnThoughts(took);
    const pages = Math.ceil(steps.length / pageSize);
    slot.entry = entry;
    for (let page = 0; page < (changed ? pages : 0); page += 1) {
      const part = steps.slice(page * pageSize, (page + 1) * pageSize);
      const shape = `${part[0]?.item.id ?? ""}:${part.length}:${entry?.endSeq ?? ""}`;
      if (slot.pages[page] === shape) continue;
      slot.pages[page] = shape;
      this.#put(`steps:${ordinal}:${page}`, () => ({
        type: "thread.stepsPage",
        ordinal,
        page,
        rows: part.map((step) => stepRow(this.#store, step.item, thoughts(step.item))),
      }));
    }
    slot.pages.length = Math.min(slot.pages.length, pages);
    this.#put(`steps:${ordinal}`, () => {
      // The turn's steps in groups, as the web's opened log groups them; rows name items the
      // pages carry. The turn is over, so nothing in it still runs.
      const items = new Map<string, Item>(steps.map((step) => [step.item.id, step.item]));
      const ids = [...items.keys()];
      const background = backgroundRows(this.#store, ids);
      const log = workLog(ids, (id) => items.get(id), {
        ...logFacts(this.#store),
        ended: () => true,
        took,
        background,
      });
      return {
        type: "thread.steps",
        ordinal,
        state: entry?.state ?? "loading",
        pages,
        count: steps.length,
        more: entry?.more === true,
        log: log.rows,
        aceSteps: log.ace,
        retried: log.retried,
        thoughts: log.thoughts,
        background,
      };
    });
  }
}
