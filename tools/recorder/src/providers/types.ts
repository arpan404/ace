import type { Recording } from "../recording.ts";
import type { Scenario } from "../scenarios.ts";

export type RunContext = {
  scenario: Scenario;
  workspace: string;
  /** Optional model override, in the provider's own naming (OpenCode: `provider/model`). */
  model?: string;
  rec: Recording;
  /** Aborted when the run must stop (quiet, max time, or failure). */
  signal: AbortSignal;
  /**
   * Resolves once the scenario has settled: at least one turn ended, no
   * interaction is pending, and the provider has been quiet for
   * `scenario.quietMs`, or the hard cap was reached.
   */
  settled: (canSettle?: () => boolean, stopSignal?: AbortSignal) => Promise<void>;
  /** Track open interactions so settling waits for them. */
  interactions: { open(): void; close(): void };
};

export type Driver = {
  id: string;
  /** Version string of the installed CLI, used in fixture paths. */
  version(): Promise<string>;
  /** Scenarios this provider can't express (skipped instead of failing). */
  unsupported?: readonly string[];
  run(ctx: RunContext): Promise<void>;
};
