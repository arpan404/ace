import { OutputLimitError } from "./output-budget.ts";
import { ProbeRequest, ProbeStop, type ProbeReply } from "./probe-messages.ts";
import { spawnRawSupervised, type RawSupervisedProcess } from "./process.ts";
import { systemListing } from "./process-listing.ts";

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
    // The main thread sends the whole environment, already resolved against its own; this
    // isolate's copy must not bring back what the caller unset.
    const env: NodeJS.ProcessEnv = { ...request.env };
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) env[key] = undefined;
    let proc: RawSupervisedProcess;
    try {
      proc = spawn({
        command: request.command,
        args: request.args,
        env,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
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
    if (proc.pid !== undefined) {
      // Read here, right after the spawn: by the time the owner hears of it the probe may have
      // exited and been reaped, and what it started could no longer be traced to it.
      const unique = systemListing.ancestry?.(proc.pid)?.unique;
      reply({ type: "spawned", id, pid: proc.pid, ...(unique ? { unique } : {}) });
    }
    // Read-only probes never write: EOF stdin so a CLI waiting on input exits.
    proc.stdin.end();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    void proc.exited
      .then((exit) => {
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
      })
      // exited never rejects; a reply that throws means the main thread is already gone.
      .catch(() => {});
  };
  return {
    handle(input) {
      const stop = ProbeStop.safeParse(input);
      if (stop.success) {
        const proc = running.get(stop.data.id);
        // Messages arrive in order, so a stop never precedes its request.
        // A surviving tree warns inside stop().
        if (proc) void proc.stop({ graceMs: 0 }).catch(() => {});
        return;
      }
      const request = ProbeRequest.safeParse(input);
      if (request.success) run(request.data);
    },
  };
}
