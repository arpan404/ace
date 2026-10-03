import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";

export interface SupervisorPorts {
  output: Writable;
  errors: Writable;
  spawnDaemon(): ChildProcess;
  launchUpdate(command: "apply" | "recover"): ChildProcess;
  journalPending(): boolean;
  dailyUpdates: boolean;
  schedule(ms: number, callback: () => void): () => void;
  subscribeStop(callback: () => void): () => void;
  report(error: unknown): void;
}
/** Fixed state, one recovery timer and one daily timer, independent of thread history. */
export function recoveryDelay(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
}
export async function runSupervisor(ports: SupervisorPorts): Promise<number> {
  let daemon: ChildProcess | undefined;
  let updater: ChildProcess | undefined;
  let cancelRecovery: (() => void) | undefined;
  let cancelDaily: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let detachUpdater: (() => void) | undefined;
  let stopping = false,
    attempt = 0,
    recovering = false;
  const retry = () => {
    if (stopping || cancelRecovery) return;
    if (ports.journalPending()) recovering = true;
    if (!recovering) return;
    cancelRecovery = ports.schedule(recoveryDelay(attempt), () => {
      cancelRecovery = undefined;
      launch("recover");
    });
    attempt = Math.min(attempt + 1, 6);
  };
  const launch = (command: "apply" | "recover") => {
    if (stopping) return;
    if (command === "recover") {
      if (!recovering && !ports.journalPending()) return;
      recovering = true;
    }
    if (updater) {
      retry();
      return;
    }
    try {
      const child = ports.launchUpdate(command);
      updater = child;
      const closed = (code: number | null = null) => {
        if (code !== null && code !== 0)
          ports.report(new Error(`Updater exited with code ${code}; pending recovery will retry`));
        detachUpdater?.();
        detachUpdater = undefined;
        updater = undefined;
        // Journal removal commits the candidate, but a crashed owner may not have
        // released its in-memory admission barrier. Finish one successful recovery.
        if (command === "recover" && code === 0 && !ports.journalPending()) recovering = false;
        retry();
      };
      const failed = (error: Error) => {
        ports.report(error);
        closed();
      };
      child.once("close", closed);
      child.once("error", failed);
      detachUpdater = () => {
        child.removeListener("close", closed);
        child.removeListener("error", failed);
      };
      // It must survive the service stop that recovery/update requests.
      child.unref();
    } catch (error) {
      ports.report(error);
      retry();
    }
  };
  const daily = () => {
    if (stopping || !ports.dailyUpdates) return;
    cancelDaily = ports.schedule(86_400_000, () => {
      cancelDaily = undefined;
      launch(ports.journalPending() ? "recover" : "apply");
      daily();
    });
  };
  const stopDaemon = () => {
    if (
      daemon &&
      daemon.pid !== undefined &&
      daemon.pid > 0 &&
      daemon.exitCode === null &&
      daemon.signalCode === null
    )
      daemon.kill("SIGTERM");
  };
  const stop = () => {
    stopping = true;
    cancelDaily?.();
    cancelRecovery?.();
    stopDaemon();
  };
  const logError = (error: Error) => {
    ports.report(error);
    stop();
  };
  let detachDaemon: (() => void) | undefined;
  try {
    ports.output.on("error", logError);
    ports.errors.on("error", logError);
    daemon = ports.spawnDaemon();
    const child = daemon;
    const result = new Promise<number>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      const closed = (code: number | null) => resolve(code ?? 1);
      child.once("error", failed);
      child.once("close", closed);
      detachDaemon = () => {
        child.removeListener("error", failed);
        child.removeListener("close", closed);
      };
    });
    child.stdout?.pipe(ports.output);
    child.stderr?.pipe(ports.errors);
    unsubscribe = ports.subscribeStop(stop);
    daily();
    if (ports.journalPending()) launch("recover");
    return await result;
  } finally {
    stopping = true;
    stopDaemon();
    cancelDaily?.();
    cancelRecovery?.();
    unsubscribe?.();
    detachDaemon?.();
    detachUpdater?.();
    daemon?.stdout?.unpipe(ports.output);
    daemon?.stderr?.unpipe(ports.errors);
    // finished is registered before end, including streams never opened after a spawn failure.
    const closing = [ports.output, ports.errors].map(async (stream) => {
      const done = finished(stream, { cleanup: true });
      stream.end();
      await done;
    });
    await Promise.allSettled(closing);
    ports.output.removeListener("error", logError);
    ports.errors.removeListener("error", logError);
  }
}
