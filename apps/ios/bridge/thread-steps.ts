import type { ChangeTap, ClientCore, ThreadSource } from "@ace/client";
import { TurnStepsCache, type TurnStepsEntry } from "@ace/client/turn-steps";
import type { Item, ThreadId } from "@ace/protocol";
import { rootRunOf } from "@ace/ui-core";
import { scheduler } from "./host.ts";
import { backgroundRows } from "./background-rows.ts";
import { itemRow, preview } from "./presentation.ts";
import { logFacts } from "./thread-blocks.ts";
import { itemDetail, stepContext } from "./thread-rows.ts";
import { workLog } from "./work-log.ts";

/*
 * A finished turn's full steps, read from the daemon (`turn.steps`, the SDK's bounded cache) only
 * while its "Worked for" log is open on the phone, and released when it closes: a long thread
 * never holds every finished step. Steps go to Swift in fixed pages, each its own patch, so a long
 * turn never travels as one frame and a page already delivered is not sent again unless it
 * changed. The root agent's own steps only, as the web shows them; the answer under the head
 * stays out. A turn that changes while its log is open (a late result landing in it) is read
 * again: its summary's `endSeq` (`turns.page`) tells the cache whether what it holds is older,
 * as the web passes it.
 */

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;
const pageSize = 25;
/** Turns one phone keeps open together; opening another closes the oldest. */
const openLimit = 4;

interface Open {
  release: () => void;
  answers: ReadonlySet<string>;
  entry: TurnStepsEntry | undefined;
  /** Pages delivered for `entry`, by their first step's id and length. */
  pages: string[];
  /** A summary read is under way; `again` asks for one more when it lands. */
  checking: boolean;
  again: boolean;
}

function stepRow(store: ThreadSource, item: Parameters<typeof itemRow>[0]) {
  const row = { ...itemRow(item), ...itemDetail(item, stepContext(store, item)) };
  // Steps read as one line each; a long thought or command keeps a bounded head.
  return { ...row, text: preview(row.text, 1024) };
}

export class StepsFollower {
  readonly #client: Pick<ClientCore, "turnsPage">;
  readonly #cache: TurnStepsCache;
  readonly #store: ThreadSource;
  readonly #threadId: ThreadId;
  readonly #put: Put;
  readonly #open = new Map<number, Open>();
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
      for (const ordinal of this.#open.keys()) this.#emit(ordinal);
    });
  }

  /** A log opened: hold its turn and read it. `answers` are the head's answer ids. */
  open(ordinal: number, answers: readonly string[]): void {
    const held = this.#open.get(ordinal);
    if (held) {
      this.#emit(ordinal);
      return;
    }
    if (this.#open.size >= openLimit) {
      const oldest = this.#open.keys().next().value;
      if (oldest !== undefined) this.close(oldest);
    }
    this.#open.set(ordinal, {
      release: () => {},
      answers: new Set(answers),
      entry: undefined,
      pages: [],
      checking: false,
      again: false,
    });
    const slot = this.#open.get(ordinal);
    if (slot) slot.release = this.#cache.retain(this.#threadId, ordinal);
    this.#emit(ordinal);
    // A read held from before may predate the turn's end: its summary says.
    void this.#check(ordinal);
  }

  /** The thread changed: an open turn whose own items moved is checked against its summary. */
  readonly changed: ChangeTap = (keys) => {
    if (!this.#open.size || keys === "all") return;
    const touched = new Set<number>();
    for (const key of keys) {
      if (!key.startsWith("item:")) continue;
      const item = this.#store.item(key.slice(5));
      const ordinal = rootRunOf(this.#store, item?.runId)?.ordinal;
      if (ordinal !== undefined && this.#open.has(ordinal)) touched.add(ordinal);
    }
    for (const ordinal of touched) void this.#check(ordinal);
  };

  close(ordinal: number): void {
    const slot = this.#open.get(ordinal);
    if (!slot) return;
    this.#open.delete(ordinal);
    slot.release();
  }

  /** Read the next part of a turn longer than one read, or again after a failed read. */
  more(ordinal: number): void {
    const slot = this.#open.get(ordinal);
    if (!slot) return;
    const entry = this.#cache.get(this.#threadId, ordinal);
    if (entry?.state === "failed") this.#cache.retain(this.#threadId, ordinal)();
    else this.#cache.loadMore(this.#threadId, ordinal);
  }

  /** Read the turn's summary; when it ended after what the cache holds, read its steps again. */
  async #check(ordinal: number): Promise<void> {
    const slot = this.#open.get(ordinal);
    if (!slot) return;
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
        if (endSeq === undefined || this.#open.get(ordinal) !== slot) return;
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
    for (const slot of this.#open.values()) slot.release();
    this.#open.clear();
    this.#cache.dropThread(this.#threadId);
  }

  #emit(ordinal: number): void {
    const slot = this.#open.get(ordinal);
    if (!slot) return;
    const entry = this.#cache.get(this.#threadId, ordinal);
    const owner = this.#store.thread?.rootAgentId;
    const steps = (entry?.steps ?? []).filter(
      (step) =>
        (owner === undefined || step.item.agentId === owner) && !slot.answers.has(step.item.id),
    );
    const pages = Math.ceil(steps.length / pageSize);
    const changed = entry !== slot.entry;
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
        rows: part.map((step) => stepRow(this.#store, step.item)),
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
        background,
      };
    });
  }
}
