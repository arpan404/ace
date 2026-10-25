// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { spawn, type ChildProcess } from "node:child_process";
import { parentPort } from "node:worker_threads";
import { ProbeRequest, ProbeStop, type ProbeReply } from "./probe-messages.ts";

/*
 * Runs bounded CLI probes for the main thread. `spawn` blocks its calling thread until the child
 * has started, which under heavy load took seconds; here that wait holds only this isolate. The
 * main thread owns each process group as soon as it hears the pid, and still stops it on exit.
 */

const port = parentPort;
if (!port) throw new Error("The probe worker runs only as a worker thread");
const running = new Map<number, { child: ChildProcess; stopped: boolean }>();
const reply = (message: ProbeReply) => port.postMessage(message);

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone, or Darwin's EPERM for a group of zombies: nothing left to stop.
  }
}

function run(request: ProbeRequest): void {
  const { id } = request;
  let child: ChildProcess;
  try {
    child = spawn(request.command, request.args, {
      env: request.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
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
  const entry = { child, stopped: false };
  running.set(id, entry);
  const { pid } = child;
  if (pid !== undefined) reply({ type: "spawned", id, pid });
  // Read-only probes never write: EOF stdin so a CLI waiting on input exits.
  child.stdin?.on("error", () => {});
  child.stdin?.end();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let limited = false;
  let failed = false;
  let finished = false;
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= request.maxBytes) target.push(chunk);
    else if (!limited) {
      limited = true;
      if (pid !== undefined) killGroup(pid);
    }
  };
  child.stdout?.on("data", collect(stdout));
  child.stderr?.on("data", collect(stderr));
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return;
    finished = true;
    running.delete(id);
    reply({
      type: "exit",
      id,
      code,
      signal,
      reason: limited
        ? "output-limit"
        : failed
          ? "spawn-error"
          : entry.stopped
            ? "stopped"
            : signal
              ? "signal"
              : "exit",
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    });
  };
  child.once("error", () => {
    failed = true;
    if (pid === undefined) finish(null, null);
  });
  // Descendants that keep the pipes open would otherwise hold the probe until its timeout.
  child.once("exit", () => {
    if (pid !== undefined) killGroup(pid);
  });
  child.once("close", finish);
}

port.on("message", (input: unknown) => {
  const stop = ProbeStop.safeParse(input);
  if (stop.success) {
    const entry = running.get(stop.data.id);
    if (!entry) return;
    entry.stopped = true;
    if (entry.child.pid !== undefined) killGroup(entry.child.pid);
    return;
  }
  const request = ProbeRequest.safeParse(input);
  if (request.success) run(request.data);
});
