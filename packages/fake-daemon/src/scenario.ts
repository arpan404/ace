import type { Fact, Key } from "@ace/core";
import type { EventPayload, GitStatusFile, InteractionResolution } from "@ace/protocol";
import type { FakeDaemon, ThreadInit } from "./daemon.ts";
import { withCardDetails } from "./scenarios/card-details.ts";

export type Step =
  | {
      kind: "update";
      changes: Omit<Extract<EventPayload, { type: "thread.updated" }>, "type">;
      label?: string;
    }
  | {
      kind: "facts";
      facts: Fact[];
      delayMs?: number;
      label?: string;
      /** How long before the daemon's now these facts happened, so seeded threads look lived in. */
      agoMs?: number;
    }
  | {
      kind: "await";
      /** Adapter key of an interaction opened earlier in the script. */
      interaction: Key;
      label?: string;
      /** Steps to run once a person answers, chosen from their answer. */
      next?: (resolution: InteractionResolution | undefined) => Step[];
    };
export interface Scenario {
  thread: ThreadInit;
  /** Actual checkout changes, independent of the transcript history. */
  gitStatus?: readonly GitStatusFile[];
  steps: Step[];
}
export interface Timer {
  set(delayMs: number, callback: () => void): () => void;
}

export interface PlayOptions {
  /** The whole scenario happened this long ago: every step is stamped this much earlier. */
  agoMs?: number;
}

/** Plays a scripted scenario into a FakeDaemon, step by step or on a timer. */
export class ScenarioPlayer {
  private daemon: FakeDaemon;
  private steps: Step[];
  private index = 0;
  private agoMs: number;
  readonly threadId: string;
  constructor(daemon: FakeDaemon, scenario: Scenario, options: PlayOptions = {}) {
    this.daemon = daemon;
    this.steps = [...scenario.steps];
    this.threadId = scenario.thread.id;
    if (scenario.gitStatus) daemon.workspace.setGitStatus(this.threadId, scenario.gitStatus);
    this.agoMs = options.agoMs ?? 0;
    const first = scenario.steps[0];
    daemon.createThread(
      withCardDetails(scenario.thread, { host: daemon.hostId, name: daemon.displayName }),
      this.agoMs + (first?.kind === "facts" ? (first.agoMs ?? 0) : 0),
    );
  }
  get done(): boolean {
    return this.index >= this.steps.length;
  }
  /** True while the next step waits for a person to answer an interaction. */
  get blocked(): boolean {
    const step = this.steps[this.index];
    return step?.kind === "await" && this.daemon.isPending(this.threadId, step.interaction);
  }
  /** Apply the next step. Returns false when finished or waiting on a person. */
  step(): boolean {
    const step = this.steps[this.index];
    if (!step || this.blocked) return false;
    this.index++;
    if (step.kind === "facts")
      this.daemon.apply(this.threadId, step.facts, this.agoMs + (step.agoMs ?? 0));
    else if (step.kind === "update")
      this.daemon.updateThread(this.threadId, step.changes, this.agoMs);
    else if (step.next)
      this.steps.splice(
        this.index,
        0,
        ...step.next(this.daemon.resolution(this.threadId, step.interaction)),
      );
    return true;
  }
  /** Apply steps through the one carrying `label`. Throws if the script cannot get there. */
  runThrough(label: string): void {
    for (;;) {
      const step = this.steps[this.index];
      if (!step) throw new Error(`Scenario has no step labelled ${label}`);
      if (!this.step()) throw new Error(`Scenario blocked before ${label}`);
      if (step.label === label) return;
    }
  }
  /** Apply steps until the script ends or waits on a person. */
  runUntilBlocked(): void {
    while (this.step()) {
      /* keep going */
    }
  }
  /** Play in real time, resuming after interactions are answered. Returns a stop function. */
  autoplay(timer: Timer, speed = 1): () => void {
    let cancel: (() => void) | undefined;
    let stopped = false;
    const schedule = () => {
      if (stopped || this.done || this.blocked) return;
      const next = this.steps[this.index];
      const delay = next?.kind === "facts" ? (next.delayMs ?? 0) / speed : 0;
      cancel = timer.set(delay, () => {
        cancel = undefined;
        this.step();
        schedule();
      });
    };
    const unsubscribe = this.daemon.onResolved((threadId) => {
      if (threadId === this.threadId && !cancel) schedule();
    });
    schedule();
    return () => {
      stopped = true;
      cancel?.();
      unsubscribe();
    };
  }
}
