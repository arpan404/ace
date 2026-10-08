import { ConductorCommandPayload } from "@ace/protocol";
import { executable } from "./outbox-policy.ts";
import type { Executor } from "./ports.ts";
import type { Effect, Environment, State } from "./schema.ts";
import type { ConductorStore } from "./store.ts";

export class ConductorDriver {
  private readonly store: ConductorStore;
  private readonly execute: Executor;
  private readonly env: Environment;
  private draining = false;
  constructor(store: ConductorStore, execute: Executor, env: Environment) {
    this.store = store;
    this.execute = execute;
    this.env = env;
  }
  command(receipt: string, input: unknown): State {
    const command = ConductorCommandPayload.parse(input);
    switch (command.type) {
      case "conductor.start":
        return this.store.create(command.runId, command.spec, this.env);
      case "conductor.approve":
        return this.store.apply(
          command.runId,
          receipt,
          { type: "approve", approval: command.approval },
          this.env,
        );
      case "conductor.pause":
        return this.store.apply(command.runId, receipt, { type: "pause" }, this.env);
      case "conductor.resume":
        return this.store.apply(command.runId, receipt, { type: "resume" }, this.env);
      case "conductor.cancel":
        return this.store.apply(command.runId, receipt, { type: "cancel" }, this.env);
    }
  }
  fact(run: string, receipt: string, input: unknown): State {
    return this.store.apply(run, receipt, input, this.env);
  }
  ready(run: string): boolean {
    const state = this.store.read(run);
    return (
      !!state && this.store.ready(run, this.env.now()).some((effect) => executable(state, effect))
    );
  }
  /** A failed intent backs off durably; unrelated intents still execute in this pass. */
  async drain(run: string, limit = 128, onFailure?: (error: unknown) => void): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1024)
      throw new Error("invalid_drain_limit");
    if (this.draining) throw new Error("driver_busy");
    this.draining = true;
    const unpin = this.store.pin(run);
    let count = 0;
    let failure: unknown;
    let failed = false;
    try {
      let batch = new Map(
        this.store.ready(run, this.env.now()).map((effect) => [effect.id, effect]),
      );
      while (count < limit) {
        const state = this.store.load(run);
        if (!state) throw new Error("run_not_found");
        let effect = this.pick(batch, state);
        if (!effect) {
          // New intents can arrive while an executor awaits. Refresh only at a
          // batch boundary, never parse the full queue for each acknowledgement.
          batch = new Map(this.store.ready(run, this.env.now()).map((item) => [item.id, item]));
          effect = this.pick(batch, state);
          if (!effect) break;
        }
        batch.delete(effect.id);
        if (!this.store.hasPending(run, effect.id)) continue;
        try {
          if (
            (state.phase === "cancelling" || state.phase === "cancelled") &&
            effect.type === "merge"
          ) {
            if (state.phase === "cancelling")
              this.store.abandonIntegration(run, effect.id, this.env);
            else this.store.complete(run, effect.id, [], this.env);
          } else if (
            "lane" in effect &&
            ["launch", "migrate"].includes(effect.type) &&
            (!state.lanes[effect.lane.id]?.live ||
              state.lanes[effect.lane.id]?.generation !== effect.lane.generation ||
              state.lanes[effect.lane.id]?.retiring)
          ) {
            this.store.complete(run, effect.id, [], this.env);
          } else if (effect.type === "gate" && !state.gates[effect.gate.id]) {
            this.store.complete(run, effect.id, [], this.env);
          } else {
            const facts = await this.execute(effect, state);
            this.store.complete(run, effect.id, facts, this.env);
          }
        } catch (error) {
          this.store.defer(run, effect.id, this.env.now());
          if (!failed) failure = error;
          failed = true;
          onFailure?.(error);
        }
        count++;
      }
      if (failed && !onFailure) throw failure;
      return count;
    } finally {
      unpin();
      this.draining = false;
    }
  }
  private pick(batch: Map<string, Effect>, state: State) {
    for (const effect of batch.values()) if (executable(state, effect)) return effect;
    return undefined;
  }
}
