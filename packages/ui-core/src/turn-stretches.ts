import type { Run } from "@ace/protocol";
import { carriesOnStretch } from "./thread-ledger.ts";

/** Server root runs grouped into working stretches; continuations retain their original turn. */
export class TurnStretches {
  private roots: {
    id: string;
    start: number;
    trigger: Run["trigger"];
    turn: string;
    end: number | undefined;
    from: number;
    idle: number;
  }[] = [];
  private readonly clocks = new Map<string, { from: number; idle: number }>();
  private readonly rootEnds = new Map<string, number | undefined>();
  private readonly rootStarts = new Map<string, number>();
  private readonly rootTriggers = new Map<string, Run["trigger"]>();
  private readonly turns = new Map<string, string>();
  private readonly lastRun = new Map<string, string>();

  reset(): void {
    this.roots = [];
    this.clocks.clear();
    this.rootEnds.clear();
    this.rootStarts.clear();
    this.rootTriggers.clear();
    this.turns.clear();
    this.lastRun.clear();
  }

  update(id: string, run: Run | undefined): readonly string[] {
    const start = run?.startedAt;
    if (
      this.rootStarts.get(id) === start &&
      this.rootTriggers.get(id) === run?.trigger &&
      this.rootEnds.get(id) === run?.endedAt
    )
      return [];
    const last = this.roots.at(-1);
    if (run && last?.id === id && last.start === run.startedAt && last.trigger === run.trigger) {
      last.end = run.endedAt;
      this.rootEnds.set(id, run.endedAt);
      return [];
    }
    if (run && !this.rootStarts.has(id) && (!last || run.startedAt >= last.start)) {
      const turn = carriesOnStretch(run.trigger) ? (last?.turn ?? id) : id;
      const from = carriesOnStretch(run.trigger) ? (last?.from ?? run.startedAt) : run.startedAt;
      const idle =
        carriesOnStretch(run.trigger) && last
          ? last.idle + Math.max(0, run.startedAt - (last.end ?? run.startedAt))
          : 0;
      this.roots.push({
        id,
        start: run.startedAt,
        trigger: run.trigger,
        turn,
        end: run.endedAt,
        from,
        idle,
      });
      this.clocks.set(id, { from, idle });
      this.rootEnds.set(id, run.endedAt);
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
        end: run.endedAt,
        from: run.startedAt,
        idle: 0,
      });
      this.rootEnds.set(id, run.endedAt);
      this.roots.sort((a, b) => a.start - b.start);
    } else {
      this.rootStarts.delete(id);
      this.rootTriggers.delete(id);
      this.rootEnds.delete(id);
      this.clocks.delete(id);
    }
    this.lastRun.clear();
    const changed: string[] = [];
    let prior: (typeof this.roots)[number] | undefined;
    for (const root of this.roots) {
      root.turn = carriesOnStretch(root.trigger) ? (prior?.turn ?? root.id) : root.id;
      root.from = carriesOnStretch(root.trigger) ? (prior?.from ?? root.start) : root.start;
      root.idle =
        carriesOnStretch(root.trigger) && prior
          ? prior.idle + Math.max(0, root.start - (prior.end ?? root.start))
          : 0;
      this.clocks.set(root.id, { from: root.from, idle: root.idle });
      if (this.turns.get(root.id) !== root.turn) changed.push(root.id);
      this.turns.set(root.id, root.turn);
      this.lastRun.set(root.turn, root.id);
      prior = root;
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

  clock(runId: string): { from: number; idle: number } | undefined {
    return this.clocks.get(this.endingRun(runId));
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
