import type { DiagnosticsHealth } from "@ace/protocol";
import type { DoctorOutcome, DoctorRuns } from "./doctor-runs.ts";
import type { SocketContext, SocketService } from "./socket.ts";

type HealthRead = { ok: true; health: DiagnosticsHealth } | { ok: false; error: string };

/**
 * Diagnostics for one socket. Checks (`doctor`, `fix`) run daemon-wide through `runs`; health
 * and toolchain reads each have their own slot on this socket, so a long checks run never makes
 * health answer busy.
 */
export function createDiagnosticsSession(
  { options, send, authorize }: SocketContext,
  runs: DoctorRuns,
): SocketService {
  let healthPending = false;
  let toolsPending = false;
  let closed = false;
  const checks = (requestId: string, operation: "doctor" | "fix") => {
    const scope = operation === "fix" ? "admin" : "read";
    const available = operation === "fix" ? options.doctorFix : options.doctor;
    const task = async (): Promise<DoctorOutcome> => {
      if (operation === "doctor") {
        const report = await options.doctor?.();
        if (!report) throw new Error("diagnostics_unavailable");
        return { report };
      }
      // Repairs stop when the device that asked for them loses its admin grant or leaves.
      const result = await options.doctorFix?.(() => {
        if (closed || !authorize(scope)) throw new Error("forbidden");
      });
      if (!result) throw new Error("diagnostics_unavailable");
      return result;
    };
    const outcome = !authorize(scope) || !available ? undefined : runs.run(operation, task);
    if (!outcome) {
      const error = !authorize(scope)
        ? "forbidden"
        : !available
          ? "diagnostics_unavailable"
          : "diagnostics_busy";
      send({ type: "diagnostics.result", requestId, error });
      return;
    }
    answer(requestId, outcome, scope);
  };
  /** Answer with a run's outcome once it ends, while this socket may still read it. */
  const answer = (requestId: string, outcome: Promise<DoctorOutcome>, scope: "read" | "admin") =>
    void outcome.then(
      (result) => {
        if (!closed && authorize(scope))
          send({
            type: "diagnostics.result",
            requestId,
            report: result.report,
            ...(result.repairs ? { repairs: result.repairs } : {}),
          });
      },
      () => {
        if (!closed) send({ type: "diagnostics.result", requestId, error: "diagnostics_failed" });
      },
    );
  /**
   * Wait for one run without ever starting work. Reading is enough, even for repairs: a device
   * that can see a run going can see how it ends.
   */
  const join = (requestId: string, runId: string | undefined) => {
    const outcome = runId === undefined || !authorize("read") ? undefined : runs.join(runId);
    if (!outcome) {
      const error = !authorize("read")
        ? "forbidden"
        : runId === undefined
          ? "invalid_request"
          : "diagnostics_run_gone";
      send({ type: "diagnostics.result", requestId, error });
      return;
    }
    answer(requestId, outcome, "read");
  };
  const toolchains = (requestId: string) => {
    const error = !authorize("read")
      ? "forbidden"
      : toolsPending
        ? "diagnostics_busy"
        : !options.toolchains
          ? "diagnostics_unavailable"
          : undefined;
    if (error) {
      send({ type: "diagnostics.result", requestId, error });
      return;
    }
    toolsPending = true;
    void Promise.resolve()
      .then(options.toolchains)
      .then(
        (found) => {
          if (!closed && authorize("read"))
            send({ type: "diagnostics.result", requestId, toolchains: found ?? [] });
        },
        () => {
          if (!closed) send({ type: "diagnostics.result", requestId, error: "diagnostics_failed" });
        },
      )
      .finally(() => {
        toolsPending = false;
      });
  };
  /** One health read at a time on this socket; `reply` answers it either way. */
  const health = (reply: (result: HealthRead) => void) => {
    const read = options.health;
    if (!read || healthPending) {
      reply({ ok: false, error: healthPending ? "diagnostics_busy" : "diagnostics_unavailable" });
      return;
    }
    healthPending = true;
    void Promise.resolve()
      .then(read)
      .then(
        (found) => reply({ ok: true, health: found }),
        () => reply({ ok: false, error: "diagnostics_failed" }),
      )
      .finally(() => {
        healthPending = false;
      });
  };
  return {
    close() {
      closed = true;
    },
    healthPending: () => Number(healthPending),
    handle(message) {
      if (message.type === "diagnostics.request") {
        if (message.operation === "status") {
          send(
            authorize("read")
              ? { type: "diagnostics.result", requestId: message.requestId, run: runs.status() }
              : { type: "diagnostics.result", requestId: message.requestId, error: "forbidden" },
          );
        } else if (message.operation === "join") join(message.requestId, message.runId);
        else if (message.operation === "toolchains") toolchains(message.requestId);
        else checks(message.requestId, message.operation);
        return true;
      }
      if (message.type !== "diagnostics.health") return false;
      if (!authorize("read")) {
        send({
          type: "diagnostics.health.result",
          requestId: message.requestId,
          ok: false,
          error: "forbidden",
        });
        return true;
      }
      health((result) => {
        if (!result.ok)
          send({
            type: "diagnostics.health.result",
            requestId: message.requestId,
            ok: false,
            error: result.error,
          });
        else if (authorize("read"))
          send({
            type: "diagnostics.health.result",
            requestId: message.requestId,
            ok: true,
            health: result.health,
          });
      });
      return true;
    },
    command: {
      types: ["diagnostics.health"],
      scope: () => "read",
      accept(command) {
        health((result) =>
          send(
            !result.ok
              ? { type: "commandResult", commandId: command.id, ok: false, error: result.error }
              : { type: "commandResult", commandId: command.id, ok: true, health: result.health },
          ),
        );
      },
    },
  };
}
