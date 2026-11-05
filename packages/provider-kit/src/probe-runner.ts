import { startBunProbe, type StartedProbe } from "./bun-probe.ts";
import { bunSpawner } from "./bun-spawn.ts";
import { OutputLimitError } from "./output-budget.ts";
import { ProbeRequest, ProbeStop, type ProbeReply, type ProbeStart } from "./probe-messages.ts";
import { spawnRawSupervised } from "./process.ts";

export type ProbeStarter = (request: ProbeStart) => StartedProbe;

/**
 * A probe as a supervised spawn, keeping every platform rule of an ordinary one: batch shims
 * run through cmd.exe, a Windows tree is killed with taskkill and held by a kill-on-close job,
 * and a POSIX group is killed when its leader exits.
 */
export function supervisedProbe(spawn: typeof spawnRawSupervised = spawnRawSupervised) {
  return (request: ProbeStart): StartedProbe => {
    // The caller sends the whole environment, already resolved; this process's own copy must
    // not bring back what the caller unset.
    const env: NodeJS.ProcessEnv = { ...request.env };
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) env[key] = undefined;
    const proc = spawn({
      command: request.command,
      args: request.args,
      env,
      name: "cli-probe",
      maxOutputBytes: request.maxBytes,
    });
    // Read-only probes never write: EOF stdin so a CLI waiting on input exits.
    proc.stdin.end();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    return {
      ...(proc.pid === undefined ? {} : { pid: proc.pid }),
      exit: proc.exited.then((exit) => ({
        code: exit.code,
        signal: exit.signal,
        reason: proc.signal.reason instanceof OutputLimitError ? "output-limit" : exit.reason,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      })),
      stop: () => void proc.stop({ graceMs: 0 }),
    };
  };
}

/** `Bun.spawn` on macOS and Linux under Bun; the supervised spawn on Windows or under Node. */
export function defaultProbeStarter(platform: NodeJS.Platform = process.platform): ProbeStarter {
  const bun = bunSpawner();
  if (bun && platform !== "win32") return (request) => startBunProbe(bun, request);
  return supervisedProbe();
}

/** The probe worker's side of the protocol: run each request, report its pid, then its exit. */
export function createProbeRunner(
  reply: (message: ProbeReply) => void,
  start: ProbeStarter = defaultProbeStarter(),
): { handle(input: unknown): void } {
  const running = new Map<number, StartedProbe>();
  const run = (request: ProbeRequest) => {
    const { id, type: _type, ...probe } = request;
    let started: StartedProbe;
    try {
      started = start(probe);
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
    running.set(id, started);
    if (started.pid !== undefined) reply({ type: "spawned", id, pid: started.pid });
    void started.exit.then((exit) => {
      running.delete(id);
      reply({ type: "exit", id, ...exit });
    });
  };
  return {
    handle(input) {
      const stop = ProbeStop.safeParse(input);
      if (stop.success) {
        // Messages arrive in order, so a stop never precedes its request.
        running.get(stop.data.id)?.stop();
        return;
      }
      const request = ProbeRequest.safeParse(input);
      if (request.success) run(request.data);
    },
  };
}
