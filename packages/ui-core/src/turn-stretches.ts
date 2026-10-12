import type { Run } from "@ace/protocol";
import { carriesOnStretch } from "./thread-ledger.ts";

/** Server root runs grouped into working stretches; continuations retain their original turn. */
export class TurnStretches {
  private roots: { id: string; start: number; trigger: Run["trigger"]; turn: string }[] = [];
  private readonly rootStarts = new Map<string, number>();
  private readonly rootTriggers = new Map<string, Run["trigger"]>();
  private readonly turns = new Map<string, string>();
  private readonly lastRun = new Map<string, string>();

  reset(): void {
    this.roots = [];
    this.rootStarts.clear();
    this.rootTriggers.clear();
    this.turns.clear();
    this.lastRun.clear();
  }

  update(id: string, run: Run | undefined): readonly string[] {
    const start = run?.startedAt;
    if (this.rootStarts.get(id) === start && this.rootTriggers.get(id) === run?.trigger) return [];
    const last = this.roots.at(-1);
    if (run && !this.rootStarts.has(id) && (!last || run.startedAt >= last.start)) {
      const turn = carriesOnStretch(run.trigger) ? (last?.turn ?? id) : id;
      this.roots.push({ id, start: run.startedAt, trigger: run.trigger, turn });
      this.rootStarts.set(id, run.startedAt);
      this.rootTriggers.set(id, run.trigger);
      this.turns.set(id, turn);
      this.lastRun.set(turn, id);
      return [id];
    }
    // Corrected or out-of-order metadata is rare; rebuild only the root stretch links.
    this.roots = this.roots.filter((root) => root.id !== id);
    if (run) {
      this.rootStarts.set(id, run.startedAt);
      this.rootTriggers.set(id, run.trigger);
      this.roots.push({
        id,
        start: run.startedAt,
        trigger: run.trigger,
        turn: id,
      });
      this.roots.sort((a, b) => a.start - b.start);
    } else {
      this.rootStarts.delete(id);
      this.rootTriggers.delete(id);
    }
    this.lastRun.clear();
    const changed: string[] = [];
    let prior: string | undefined;
    for (const root of this.roots) {
      root.turn = carriesOnStretch(root.trigger) ? (prior ?? root.id) : root.id;
      if (this.turns.get(root.id) !== root.turn) changed.push(root.id);
      this.turns.set(root.id, root.turn);
      this.lastRun.set(root.turn, root.id);
      prior = root.turn;
    }
    if (!run) this.turns.delete(id);
    return changed;
  }

  turnId(runId: string): string {
    return this.turns.get(runId) ?? runId;
  }
  endingRun(runId: string): string {
    return this.lastRun.get(this.turnId(runId)) ?? runId;
  }

  /** Parent run gaps are still work by its tree; only human waits pause the live timer. */
  clock(runId: string): { from: number; idle: number } | undefined {
    const from = this.rootStarts.get(this.turnId(runId));
    return from === undefined ? undefined : { from, idle: 0 };
  }

  latest(): string | undefined {
    return this.roots.at(-1)?.id;
  }

  at(at: number): string | undefined {
    let low = 0;
    let high = this.roots.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.roots[middle]?.start ?? 0) <= at) low = middle + 1;
      else high = middle;
    }
    return this.roots[low - 1]?.id;
  }
}
