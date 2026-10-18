import type { ClientCore, ThreadSource } from "@ace/client";
import { TurnStepsCache, type TurnStepsEntry } from "@ace/client/turn-steps";
import type { ThreadId } from "@ace/protocol";
import { scheduler } from "./host.ts";
import { itemRow, preview } from "./presentation.ts";
import { itemDetail } from "./thread-rows.ts";

/*
 * A finished turn's full steps, read from the daemon (`turn.steps`, the SDK's bounded cache) only
 * while its "Worked for" log is open on the phone, and released when it closes: a long thread
 * never holds every finished step. Steps go to Swift in fixed pages, each its own patch, so a long
 * turn never travels as one frame and a page already delivered is not sent again unless it
 * changed. The root agent's own steps only, as the web shows them; the answer under the head
 * stays out.
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
}

function stepRow(item: Parameters<typeof itemRow>[0]) {
  const row = { ...itemRow(item), ...itemDetail(item) };
  // Steps read as one line each; a long thought or command keeps a bounded head.
  return { ...row, text: preview(row.text, 1024) };
}

export class StepsFollower {
  readonly #cache: TurnStepsCache;
  readonly #store: ThreadSource;
  readonly #threadId: ThreadId;
  readonly #put: Put;
  readonly #open = new Map<number, Open>();
  readonly #stop: () => void;

  constructor(client: ClientCore, store: ThreadSource, threadId: ThreadId, put: Put) {
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
    });
    const slot = this.#open.get(ordinal);
    if (slot) slot.release = this.#cache.retain(this.#threadId, ordinal);
    this.#emit(ordinal);
  }

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
        rows: part.map((step) => stepRow(step.item)),
      }));
    }
    slot.pages.length = Math.min(slot.pages.length, pages);
    this.#put(`steps:${ordinal}`, () => ({
      type: "thread.steps",
      ordinal,
      state: entry?.state ?? "loading",
      pages,
      count: steps.length,
      more: entry?.more === true,
    }));
  }
}
