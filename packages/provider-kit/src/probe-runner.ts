import { OutputLimitError } from "./output-budget.ts";
import { ProbeRequest, ProbeStop, type ProbeReply } from "./probe-messages.ts";
import { spawnRawSupervised, type RawSupervisedProcess } from "./process.ts";

/**
 * The probe worker's side of the protocol. Each probe is a supervised spawn, so it keeps every
 * platform rule of an ordinary one: batch shims run through cmd.exe, a Windows tree is killed with
 * taskkill and held by a kill-on-close job, and a POSIX group is killed when its leader exits.
 */
export function createProbeRunner(
  reply: (message: ProbeReply) => void,
  spawn: typeof spawnRawSupervised = spawnRawSupervised,
): { handle(input: unknown): void } {
  const running = new Map<number, RawSupervisedProcess>();
  const run = (request: ProbeRequest) => {
    const { id } = request;
    let proc: RawSupervisedProcess;
    try {
      proc = spawn({
        command: request.command,
        args: request.args,
        env: request.env,
        name: "cli-probe",
        maxOutputBytes: request.maxBytes,
      });
    } catch {
      reply({
        type: "exit",
        id,
        code: null,
        signal: null,
        reason: "spawn-error",
        stdout: "",
        stderr: "",
      });
      return;
    }
    running.set(id, proc);
    if (proc.pid !== undefined) reply({ type: "spawned", id, pid: proc.pid });
    // Read-only probes never write: EOF stdin so a CLI waiting on input exits.
    proc.stdin.end();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    void proc.exited.then((exit) => {
      running.delete(id);
      reply({
        type: "exit",
        id,
        code: exit.code,
        signal: exit.signal,
        reason: proc.signal.reason instanceof OutputLimitError ? "output-limit" : exit.reason,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  };
  return {
    handle(input) {
      const stop = ProbeStop.safeParse(input);
      if (stop.success) {
        const proc = running.get(stop.data.id);
        // Messages arrive in order, so a stop never precedes its request.
        if (proc) void proc.stop({ graceMs: 0 });
        return;
      }
      const request = ProbeRequest.safeParse(input);
      if (request.success) run(request.data);
    },
  };
}
