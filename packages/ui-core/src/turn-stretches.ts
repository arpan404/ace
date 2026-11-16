import type { Run } from "@ace/protocol";
import { carriesOnStretch } from "./thread-ledger.ts";

/** Runs ace starts to continue a turn after waiting: it was down (a restart), or a limit held it. */
const resumes = new Set<Run["trigger"]>(["restart", "limit_resume"]);

/** Server root runs grouped into working stretches; continuations retain their original turn. */
export class TurnStretches {
  private roots: { id: string; start: number; trigger: Run["trigger"]; turn: string }[] = [];
  private readonly rootStarts = new Map<string, number>();
  private readonly rootTriggers = new Map<string, Run["trigger"]>();
  private readonly rootEnds = new Map<string, number>();
  private readonly turns = new Map<string, string>();
  private readonly lastRun = new Map<string, string>();

  reset(): void {
    this.roots = [];
    this.rootStarts.clear();
    this.rootTriggers.clear();
    this.rootEnds.clear();
    this.turns.clear();
    this.lastRun.clear();
  }

  update(id: string, run: Run | undefined): readonly string[] {
    if (run?.endedAt === undefined) this.rootEnds.delete(id);
    else this.rootEnds.set(id, run.endedAt);
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

  /**
   * Parent run gaps are still work by its tree (its children worked on), except the waits ace's
   * own continuation ended: ace down before a restart's, the limit before a limit resume's.
   */
  clock(runId: string): { from: number; idle: number } | undefined {
    const turn = this.turnId(runId);
    const from = this.rootStarts.get(turn);
    return from === undefined ? undefined : { from, idle: this.waitedOut(turn, from) };
  }

  /** The turn's runs are consecutive roots from its own start: walk only those. */
  private waitedOut(turn: string, from: number): number {
    let low = 0;
    let high = this.roots.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.roots[middle]?.start ?? 0) < from) low = middle + 1;
      else high = middle;
    }
    let idle = 0;
    let previous: string | undefined;
    for (let index = low; index < this.roots.length; index++) {
      const root = this.roots[index];
      if (!root) break;
      if (root.turn !== turn) {
        if (previous !== undefined) break;
        continue;
      }
      const ended = previous === undefined ? undefined : this.rootEnds.get(previous);
      if (resumes.has(root.trigger) && ended !== undefined && root.start > ended)
        idle += root.start - ended;
      previous = root.id;
    }
    return idle;
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
