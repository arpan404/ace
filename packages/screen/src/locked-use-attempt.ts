/*
 * One protected interval on a locked Mac: the service covers the displays, unlocks under the
 * covers and reports `working`; only then does the approved work run. `finish` asks it to
 * relock, and its `completion` arrives once the work exited and the OS confirmed the lock.
 * Anything else (a refusal, an error event, a phase other than the expected ones, a timeout,
 * the connection closing) fails the attempt. Work that has not started never starts; work that
 * is running is aborted and awaited, and the attempt is cancelled.
 */
import { ComputerError } from "./computer/errors.ts";
import { LockedUseReplyError, type LockedUseConnection } from "./locked-use-connection.ts";
import type { Scheduler } from "./runtime.ts";
import type { LockedUseEvent, LockedUseServiceStatus } from "./locked-use-wire.ts";

/** Locked computer use could not run, or stopped, a step. The message is for the model. */
export class LockedUseAttemptError extends ComputerError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LockedUseAttemptError";
  }
}

export interface ProtectedAttempt<T> {
  threadID: string;
  turnID: string;
  /** Processes whose posted input is the agent's, not the person taking over. */
  agentProcessIDs: readonly number[];
  /** Unguessable and never reused. */
  attemptID: string;
  /** The approved computer-use step; it must stop when `signal` aborts. */
  work: (signal: AbortSignal) => Promise<T>;
  scheduler: Scheduler;
  /** The tool call's own cancellation: it stops the attempt at any stage. */
  signal?: AbortSignal;
  /** How long the service may take to reach `working` after `begin`. */
  readyTimeoutMs?: number;
  /** How long relock may take to be confirmed after the work ends. */
  relockTimeoutMs?: number;
}

const notRun = "Nothing ran in the app; the Mac stays locked.";
const tookOver =
  "The person took over the Mac, so locked computer use stopped and the Mac was locked again. Don't retry; continue with other tools or wait for the person.";

const starting = new Set(["covering", "authorizing", "unlocking"]);

function refused(error: unknown): LockedUseAttemptError {
  if (error instanceof LockedUseAttemptError) return error;
  if (error instanceof LockedUseReplyError) {
    if (error.code === "manual_unlock_required")
      return new LockedUseAttemptError("person_took_over", tookOver);
    return new LockedUseAttemptError(
      `locked_use_${error.code}`,
      `Locked computer use did not start: ${error.message} ${notRun}`,
    );
  }
  return new LockedUseAttemptError(
    "locked_use_unavailable",
    `Locked computer use is unavailable: ${error instanceof Error ? error.message : String(error)}. ${notRun}`,
  );
}

function stopped(reason: string, detail?: string | null): LockedUseAttemptError {
  if (reason === "localInput") return new LockedUseAttemptError("person_took_over", tookOver);
  return new LockedUseAttemptError(
    `locked_use_${reason}`,
    `Locked computer use stopped (${reason}${detail ? `: ${detail}` : ""}) and the Mac was locked again. Observe again before acting.`,
  );
}

/** A service error or refusal after the step started: nothing about "nothing ran". */
function interrupted(error: unknown, relocking: boolean): LockedUseAttemptError {
  if (error instanceof LockedUseAttemptError) return error;
  if (error instanceof LockedUseReplyError && error.code === "manual_unlock_required")
    return new LockedUseAttemptError("person_took_over", tookOver);
  const code = error instanceof LockedUseReplyError ? error.code : "unavailable";
  const detail = error instanceof Error ? error.message : String(error);
  return new LockedUseAttemptError(
    `locked_use_${code}`,
    relocking
      ? `The step ran, but locking the Mac again reported a problem (${detail}). Stop computer actions and tell the person.`
      : `Locked computer use stopped (${detail}) and the Mac is being locked again. Observe again before acting.`,
  );
}

function phaseFailure(phase: string): LockedUseAttemptError {
  if (phase === "manualUnlockRequired")
    return new LockedUseAttemptError("person_took_over", tookOver);
  return new LockedUseAttemptError(
    `locked_use_${phase}`,
    `Locked computer use stopped: the service went to ${phase}. Observe again before acting.`,
  );
}

/** Reads a fresh status, enabling the service first if it is off, and checks it can begin. */
async function readyStatus(connection: LockedUseConnection): Promise<LockedUseServiceStatus> {
  let status = await connection.request({ type: "status" });
  if (status?.phase === "disabled") status = await connection.request({ type: "enable" });
  if (!status) throw new Error("the service sent no status");
  if (!status.installation.verified)
    throw new LockedUseAttemptError(
      "locked_use_not_installed",
      `Locked computer use is not installed and verified. ${notRun}`,
    );
  if (status.session !== "locked")
    throw new LockedUseAttemptError(
      "locked_use_not_locked",
      "The Mac is not locked. Observe again.",
    );
  if (status.phase !== "ready")
    throw new LockedUseAttemptError(
      "locked_use_busy",
      `Locked computer use is ${status.phase}. ${notRun}`,
    );
  if (typeof status.userID !== "number" || typeof status.sessionID !== "number")
    throw new LockedUseAttemptError(
      "locked_use_unavailable",
      `The locked session is unknown. ${notRun}`,
    );
  return status;
}

export async function runProtectedAttempt<T>(
  connection: LockedUseConnection,
  attempt: ProtectedAttempt<T>,
): Promise<T> {
  let status: LockedUseServiceStatus;
  try {
    status = await readyStatus(connection);
  } catch (error) {
    throw refused(error);
  }
  const { attemptID, scheduler } = attempt;
  // stopping: the service ended the interval on its own and is relocking; its completion
  // carries the reason.
  let stage: "begin" | "starting" | "working" | "stopping" | "finishing" | "done" = "begin";
  let failure: LockedUseAttemptError | undefined;
  const working = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  // Rejections are read through `failure`; these must never surface as unhandled.
  working.promise.catch(() => {});
  completed.promise.catch(() => {});
  const abort = new AbortController();
  const timers: (() => void)[] = [];
  // Only bounds the wait for `working`; cleared the moment it arrives.
  let stopReady: (() => void) | undefined;

  const fail = (error: LockedUseAttemptError) => {
    if (failure || stage === "done") return;
    failure = error;
    working.reject(error);
    completed.reject(error);
    abort.abort(error);
  };
  const currentStage = () => stage;
  // States that arrive before the begin reply is read; replayed after it, in wire order.
  const early: LockedUseServiceStatus[] = [];
  const observe = (next: LockedUseServiceStatus) => {
    const ours = next.attemptID === attemptID;
    if (stage === "begin") early.push(next);
    else if (stage === "starting") {
      if (next.phase === "working" && ours) {
        stage = "working";
        stopReady?.();
        working.resolve();
      } else if (!(starting.has(next.phase) && ours)) fail(phaseFailure(next.phase));
    } else if (stage === "working") {
      if (next.phase === "relocking" && ours) {
        stage = "stopping";
        abort.abort();
      } else if (next.phase !== "working" || !ours) fail(phaseFailure(next.phase));
    } else if (stage === "stopping" || stage === "finishing") {
      if (next.phase === "faulted" || next.phase === "manualUnlockRequired")
        fail(phaseFailure(next.phase));
    }
  };
  const onEvent = (event: LockedUseEvent) => {
    if (event.type === "state") return observe(event.status);
    if (event.attemptID != null && event.attemptID !== attemptID) return;
    if (event.type === "error") {
      const error = new LockedUseReplyError(event.code, event.message);
      return fail(
        stage === "begin" || stage === "starting"
          ? refused(error)
          : interrupted(error, stage === "finishing"),
      );
    }
    if (stage === "finishing" && event.reason === "finished") return completed.resolve();
    fail(stopped(event.reason, event.workError));
  };
  const stops = [
    connection.onEvent(onEvent),
    connection.onClose(() =>
      fail(
        new LockedUseAttemptError(
          "locked_use_connection_lost",
          "Locked computer use lost its service, so it stopped and the Mac is being locked again. Observe again before acting.",
        ),
      ),
    ),
  ];
  if (attempt.signal) {
    const signal = attempt.signal;
    const onAbort = () =>
      fail(new LockedUseAttemptError("cancelled", "Cancelled. The Mac is being locked again."));
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    stops.push(() => signal.removeEventListener("abort", onAbort));
  }
  const deadline = (ms: number, error: LockedUseAttemptError) =>
    timers.push(scheduler.after(ms, () => fail(error)));
  const cancel = () => {
    if (!connection.closed) void connection.request({ type: "cancel", attemptID }).catch(() => {});
  };
  // Whether the service may hold an attempt: begin was sent and not explicitly refused. A
  // begin that timed out or lost its reply may still have started one, so it is cancelled.
  let mayHoldAttempt = false;

  try {
    stopReady = scheduler.after(attempt.readyTimeoutMs ?? 15_000, () =>
      fail(
        new LockedUseAttemptError(
          "locked_use_timeout",
          `Locked computer use did not unlock in time. ${notRun}`,
        ),
      ),
    );
    timers.push(() => stopReady?.());
    // Cancelled or closed before it began: nothing is sent.
    if (!failure)
      try {
        mayHoldAttempt = true;
        const begun = await connection.request({
          type: "begin",
          scope: {
            userID: status.userID ?? 0,
            sessionID: status.sessionID ?? 0,
            threadID: attempt.threadID,
            turnID: attempt.turnID,
            attemptID,
          },
          agentProcessIDs: attempt.agentProcessIDs,
        });
        stage = "starting";
        for (const next of [...(begun ? [begun] : []), ...early.splice(0)]) observe(next);
      } catch (error) {
        if (error instanceof LockedUseReplyError) mayHoldAttempt = false;
        fail(refused(error));
      }
    await working.promise.catch(() => {});
    if (failure) {
      if (mayHoldAttempt) cancel();
      throw failure;
    }
    // Working: the approved step runs, and stops if protection goes. Protection that already
    // went (a relock read together with `working`) means the step never starts.
    const outcome = abort.signal.aborted
      ? { ok: false as const, error: new LockedUseAttemptError("locked_use_stopped", notRun) }
      : await attempt.work(abort.signal).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
    // Read through a call: the event handlers move `stage` while the work runs.
    if (currentStage() === "stopping" && !failure) {
      // Never a success: wait for the completion's reason (a takeover, an expiry).
      deadline(
        attempt.relockTimeoutMs ?? 30_000,
        new LockedUseAttemptError(
          "locked_use_relock_unconfirmed",
          "Locked computer use stopped, and the Mac's relock was not confirmed. Stop computer actions and tell the person.",
        ),
      );
      await completed.promise.catch(() => {});
    }
    if (failure) {
      cancel();
      throw failure;
    }
    stage = "finishing";
    deadline(
      attempt.relockTimeoutMs ?? 30_000,
      new LockedUseAttemptError(
        "locked_use_relock_unconfirmed",
        "The step ran, but the Mac's relock was not confirmed. Stop computer actions and tell the person.",
      ),
    );
    try {
      await connection.request({ type: "finish", attemptID });
    } catch (error) {
      fail(interrupted(error, true));
    }
    await completed.promise.catch(() => {});
    if (failure) throw failure;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    stage = "done";
    for (const stop of [...stops, ...timers]) stop();
  }
}
