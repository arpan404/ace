import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UtilityModel } from "@ace/models";
import {
  spawnRawSupervised,
  type SpawnOptions,
  type RawSupervisedProcess,
} from "@ace/provider-kit/process";
import { systemClock, type EngineClock } from "./engine/actor.ts";
import { utilityInvocation, utilityReply } from "./utility-cli-args.ts";

/** Where a provider's CLI is and the environment that selects the account. */
export interface UtilityLaunch {
  path: string;
  env: NodeJS.ProcessEnv;
}
export type UtilityLocate = (
  target: UtilityModel,
  signal: AbortSignal,
) => Promise<UtilityLaunch | undefined>;
export interface UtilityCliOptions {
  locate: UtilityLocate;
  spawn?: (options: SpawnOptions) => RawSupervisedProcess;
  clock?: EngineClock;
  tempRoot?: string;
}
export interface UtilityRun {
  prompt: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** Output beyond this is a failure; generations are short. */
  maxOutputBytes: number;
}
export type UtilityCli = (target: UtilityModel, run: UtilityRun) => Promise<string>;

/**
 * One restricted CLI run through the person's own installed, signed-in provider, outside any
 * checkout. It owns no engine agent or continuation, and never sees credentials. Failures are
 * fixed codes (`utility_unavailable`, `utility_timeout`, `utility_provider_failed`,
 * `utility_invalid_output`, `utility_cancelled`); provider diagnostics are discarded.
 */
export function createUtilityCli(options: UtilityCliOptions): UtilityCli {
  const spawn = options.spawn ?? spawnRawSupervised;
  const clock = options.clock ?? systemClock;
  return async (target, run) => {
    const { signal } = run;
    signal.throwIfAborted();
    const launch = await options.locate(target, signal);
    if (!launch) throw new Error("utility_unavailable");
    signal.throwIfAborted();
    const invocation = utilityInvocation(
      target.provider,
      target.launchModel,
      target.effort,
      run.prompt,
    );
    const directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "ace-utility-"));
    let child: RawSupervisedProcess | undefined;
    let cancelTimer: (() => void) | undefined;
    let timedOut = false;
    const stop = () => {
      void child?.stop({ graceMs: 0 });
    };
    try {
      child = spawn({
        command: launch.path,
        args: invocation.args,
        cwd: directory,
        env: launch.env,
        name: "utility-generation",
        maxOutputBytes: run.maxOutputBytes,
      });
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      cancelTimer = clock.setTimer(() => {
        timedOut = true;
        stop();
      }, run.timeoutMs);
      const chunks: Buffer[] = [];
      child.stdout.on("data", (bytes: Buffer) => chunks.push(bytes));
      // Diagnostic bytes are bounded by supervision and discarded, never sent to clients.
      child.stderr.resume();
      child.stdin.end(invocation.stdin ? run.prompt : undefined);
      const exit = await child.exited;
      signal.throwIfAborted();
      if (timedOut) throw new Error("utility_timeout");
      if (exit.code !== 0 || exit.reason !== "exit") throw new Error("utility_provider_failed");
      return utilityReply(target.provider, Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (signal.aborted) {
        // oxlint-disable-next-line eslint/preserve-caught-error -- External diagnostics may contain credentials.
        throw new Error("utility_cancelled");
      }
      if (error instanceof Error && error.message.startsWith("utility_")) throw error;
      // oxlint-disable-next-line eslint/preserve-caught-error -- External diagnostics may contain credentials.
      throw new Error("utility_invalid_output");
    } finally {
      cancelTimer?.();
      signal.removeEventListener("abort", stop);
      await child?.stop({ graceMs: 0 });
      await rm(directory, { recursive: true, force: true });
    }
  };
}
