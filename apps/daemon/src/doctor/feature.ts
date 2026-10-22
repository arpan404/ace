import type { Check } from "@ace/diagnostics";
import type { DiagnosticRepair, DiagnosticReport } from "@ace/protocol";
import type { Client } from "@ace/client";
import type { Config } from "../config.ts";
import type { PlannedRepair } from "../doctor-plan.ts";

/**
 * What a doctor feature may use. Everything that touches the world is here so features stay
 * testable: give them a temp data folder, a fixed clock and a fake `daemon`.
 */
export type DoctorContext = {
  config: Config;
  env: NodeJS.ProcessEnv;
  /** The person's home folder, for showing paths as `~/…`. */
  home: string;
  platform: NodeJS.Platform;
  now: () => number;
  /** From the daemon's run file and a pid probe, read once before checks start. */
  daemonState: "running" | "stopped";
  /**
   * Runs `use` against the local daemon. Resolves undefined when the daemon is down or
   * doesn't answer; never throws for an unreachable daemon. Doctor must work without it.
   */
  daemon<T>(use: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T | undefined>;
};

/**
 * One area of `ace doctor`: its checks and, optionally, the repairs it offers. Check ids are
 * prefixed with the feature id. Checks are read-only; only `apply` may change anything, and
 * only for repairs the person chose.
 */
export type DoctorFeature = {
  id: string;
  checks(context: DoctorContext): Check[];
  repairs?(report: DiagnosticReport, context: DoctorContext): PlannedRepair[];
  apply?(
    repairId: string,
    report: DiagnosticReport,
    context: DoctorContext,
  ): Promise<DiagnosticRepair[]>;
};
