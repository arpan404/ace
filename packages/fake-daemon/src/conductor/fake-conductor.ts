import type { ConductorCommandPayload } from "@ace/protocol";
import { active, approve, draft, logged, reject, schedule } from "./presentation-decisions.ts";
import {
  createExecution,
  commandExecution,
  executionRun,
  observeExecution,
  artifactExecution,
} from "./execution.ts";
import { deckRuns, stagedDeck } from "./decks.ts";
import type { FakeDeckRun, FakeDeckScenario } from "./types.ts";

export type FakeConductorResult = { ok: true } | { ok: false; error: string };

/**
 * An in-memory conductor that serves deck runs and applies the real `conductor.*` command
 * payloads to them: start drafts a plan behind a plan gate, approve applies the gate, pause,
 * resume and cancel move the phase. Every change replaces the runs array, so readers can
 * compare by reference.
 */
export class FakeConductor {
  private clock: () => number;
  private list: readonly FakeDeckRun[];
  private paused = new Map<string, FakeDeckRun["phase"]>();
  private listeners = new Set<() => void>();
  constructor(options: { clock(): number; runs?: FakeDeckRun[] }) {
    this.clock = options.clock;
    this.list = options.runs ?? deckRuns(options.clock());
  }
  runs(): readonly FakeDeckRun[] {
    return this.list;
  }
  /** Replace every run, as a conductor restored from its store. */
  load(runs: FakeDeckRun[]): void {
    this.list = runs;
    this.paused.clear();
    this.emit();
  }
  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= 64) throw new Error("subscription_limit");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  command(payload: ConductorCommandPayload): FakeConductorResult {
    if (payload.type === "conductor.start") {
      if (this.list.length >= 64) return { ok: false, error: "run_limit" };
      if (this.find(payload.runId)) return { ok: false, error: "already_exists" };
      const run = draft(
        payload.runId,
        {
          ...payload.spec,
          constraints: { ...payload.spec.constraints, budget: 100000, deadline: null },
        },
        this.clock(),
      );
      this.list = [
        executionRun(run, createExecution(run, payload.spec, this.clock())),
        ...this.list,
      ];
      this.emit();
      return { ok: true };
    }
    const run = this.find(payload.runId);
    if (!run) return { ok: false, error: "not_found" };
    const now = this.clock();
    if (run.execution) {
      try {
        commandExecution(run.execution, payload, now);
        this.replace(executionRun(run, run.execution));
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "conductor_command_failed",
        };
      }
    }
    switch (payload.type) {
      case "conductor.approve": {
        const gate = run.gate;
        if (!gate || gate.id !== payload.approval.gateId) return { ok: false, error: "stale_gate" };
        // A paused deck takes the decision but schedules nothing until it resumes.
        const held = run.phase === "paused";
        const base = held ? { ...run, phase: this.paused.get(run.id) ?? "dealing" } : run;
        const next =
          payload.approval.decision === "approve"
            ? approve(base, gate, payload.approval, now, held)
            : reject(base, gate, now, held, payload.approval.feedback);
        if (typeof next === "string") return { ok: false, error: next };
        if (held && next.phase !== "cancelled" && next.phase !== "merged") {
          this.paused.set(run.id, next.phase);
          this.replace({ ...next, phase: "paused" });
        } else {
          this.paused.delete(run.id);
          this.replace(next);
        }
        return { ok: true };
      }
      case "conductor.pause":
        if (!active(run)) return { ok: false, error: "not_running" };
        this.paused.set(run.id, run.phase);
        this.replace(logged({ ...run, phase: "paused" }, now, "You paused the deck."));
        return { ok: true };
      case "conductor.resume": {
        if (run.executionError) {
          const { executionError: _, ...rest } = run;
          this.replace(logged(rest, now, "You resumed the deck."));
          return { ok: true };
        }
        const phase = this.paused.get(run.id);
        if (run.phase !== "paused" || !phase) return { ok: false, error: "not_paused" };
        this.paused.delete(run.id);
        this.replace(schedule(logged({ ...run, phase }, now, "You resumed the deck."), now));
        return { ok: true };
      }
      case "conductor.cancel":
        if (run.phase === "merged" || run.phase === "cancelled")
          return { ok: false, error: "finished" };
        this.replace(
          logged({ ...run, phase: "cancelled", gate: null }, now, "You cancelled the deck."),
        );
        return { ok: true };
    }
  }
  /** Add a staged deck (a first plan, a used budget, an unresponsive lane) to the runs. */
  stage(scenario: FakeDeckScenario): void {
    const run = stagedDeck(scenario, this.clock());
    if (this.find(run.id)) return;
    this.list = [run, ...this.list];
    this.emit();
  }
  /** The conductor couldn't run the deck's next step; it stays stopped until resumed. */
  fail(runId: string, code: string): void {
    const run = this.find(runId);
    if (run) this.replace({ ...run, executionError: code, updatedAt: this.clock() });
  }
  /** The person answered a worker's question: its card carries on. */
  answer(runId: string, cardId: string): void {
    const run = this.find(runId);
    const card = run?.cards.find((entry) => entry.id === cardId);
    if (!run || !card?.question) return;
    const cards = run.cards.map((entry) =>
      entry.id === cardId ? { ...entry, question: null } : entry,
    );
    this.replace(logged({ ...run, cards }, this.clock(), `You answered ${card.title}.`));
  }
  /** Script a canonical provider/tree fact on a newly started Deck. */
  observe(runId: string, input: unknown): void {
    const run = this.find(runId);
    if (!run?.execution) throw new Error("fake_execution_missing");
    observeExecution(run.execution, input, this.clock());
    this.replace(executionRun(run, run.execution));
  }
  /** Complete provider output follows the same parser and bounded correction rules as native lanes. */
  artifact(runId: string, laneId: string, itemId: string, text: string): void {
    const run = this.find(runId);
    if (!run?.execution) throw new Error("fake_execution_missing");
    artifactExecution(run.execution, laneId, itemId, text, this.clock());
    this.replace(executionRun(run, run.execution));
  }
  private find(id: string): FakeDeckRun | undefined {
    return this.list.find((run) => run.id === id);
  }
  private replace(next: FakeDeckRun): void {
    this.list = this.list.map((run) => (run.id === next.id ? next : run));
    this.emit();
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
