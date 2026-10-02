import { ConductorCommandPayload } from "@ace/protocol";
import { executable } from "./outbox-policy.ts";
import type { Executor } from "./ports.ts";
import type { Environment, State } from "./schema.ts";
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
  /** Bounded drain; errors keep the current effect durable for retry. No polling or timers. */
  async drain(run: string, limit = 128): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1024)
      throw new Error("invalid_drain_limit");
    if (this.draining) throw new Error("driver_busy");
    this.draining = true;
    let count = 0;
    try {
      while (count < limit) {
        const state = this.store.load(run);
        if (!state) throw new Error("run_not_found");
        const pending = this.store.pending(run);
        const effect = pending.find((e) => executable(state, e));
        if (!effect) break;
        if (
          (state.phase === "cancelling" || state.phase === "cancelled") &&
          effect.type === "merge"
        ) {
          if (state.phase === "cancelling") this.store.abandonIntegration(run, effect.id, this.env);
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
          const facts = await this.execute(effect);
          this.store.complete(run, effect.id, facts, this.env);
        }
        count++;
      }
      return count;
    } finally {
      this.draining = false;
    }
  }
}
