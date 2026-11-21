import { parseSpadeTree, spadeTreeWorkers, type SpadeWorkerNode } from "@ace/ui-core/spade-chat";
import type { SpadeBubbleRow } from "./spade-rows.ts";

/*
 * The open chat's bot's tree of workers (`GET /v1/agents/{id}/tree`, ADR 0161), read while its
 * chat shows a bot worker, and again every few seconds while any of them may still run: the
 * roster lists a bot still queued for a slot as idle, and only the tree says it hasn't started.
 * Its last good answer stays while a read fails.
 */

/** How often the tree is read again while a bot worker may still run, as the web reads it. */
const every = 4_000;

export interface SpadeWorkerTreeDeps {
  read(path: string): Promise<string>;
  later(delay: number, callback: () => void): () => void;
}

export class SpadeWorkerTree {
  private bot: string | undefined;
  private nodes: ReadonlyMap<string, SpadeWorkerNode> = new Map();
  private reading = false;
  private timer: (() => void) | undefined;
  /** Bumped by `stop`, so a read begun for another chat lands nowhere. */
  private generation = 0;
  private readonly deps: SpadeWorkerTreeDeps;
  private readonly changed: () => void;

  constructor(deps: SpadeWorkerTreeDeps, changed: () => void) {
    this.deps = deps;
    this.changed = changed;
  }

  /** A worker of the open chat's bot, as its tree last said; undefined before it is read. */
  node(id: string): SpadeWorkerNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * The open chat's rows as last put, by the bot `bot`: its tree is read while they show a bot
   * worker, and kept being read while any may still run.
   */
  showing(bot: string | undefined, rows: readonly { row: SpadeBubbleRow }[]): void {
    const workers = rows.flatMap(({ row }) =>
      row.kind === "workers" ? row.workers.filter((worker) => worker.kind === "bot") : [],
    );
    if (!bot || workers.length === 0) return;
    if (bot !== this.bot) {
      this.stop();
      this.bot = bot;
    }
    const unread = workers.some((worker) => !this.nodes.has(worker.id));
    const moving = workers.some((worker) => worker.tone !== "rest");
    if (this.reading || this.timer) return;
    if (unread && this.nodes.size === 0) return void this.read();
    if (unread || moving) this.timer = this.deps.later(every, () => this.read());
  }

  stop(): void {
    this.generation++;
    this.timer?.();
    this.timer = undefined;
    this.reading = false;
    this.bot = undefined;
    this.nodes = new Map();
  }

  private async read() {
    this.timer = undefined;
    const bot = this.bot;
    if (!bot) return;
    const generation = this.generation;
    this.reading = true;
    const body = await this.deps
      .read(`/v1/agents/${encodeURIComponent(bot)}/tree`)
      .catch(() => undefined);
    if (generation !== this.generation) return;
    this.reading = false;
    const tree = body === undefined ? undefined : parseSpadeTree(body);
    if (tree) this.nodes = spadeTreeWorkers(tree);
    // Redrawn either way, so the rows schedule the next read.
    this.changed();
  }
}
