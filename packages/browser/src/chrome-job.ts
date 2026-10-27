import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { createRetainedJob, type RetainedJob } from "@ace/provider-kit/process-containment";
import type { ProcessSpawner } from "./io.ts";
import type { ChromeLaunch } from "./chrome-instance.ts";

/*
 * Windows has no process groups and no `ps` for the guardian. Each profile's Chrome runs in a
 * kill-on-close job instead: the kernel ends the whole tree (GPU, renderers, crashpad) when the
 * daemon's handle closes, even when the daemon crashes. Containment is required: a job that
 * can't be made or joined fails the launch rather than run Chrome uncontained.
 *
 * Node can't start a process suspended or inside a job, so the first process is a gate, as for
 * Windows terminals: a small Node script that waits on a pipe until it has joined the job and
 * only then starts Chrome, which is therefore born inside it with every child it makes. The gate
 * is Node rather than cmd.exe because Chrome reads its debugging pipe from inherited C runtime
 * descriptors 3 and 4, which Node passes on and cmd.exe does not.
 */

const profileFlag = "--user-data-dir=";

/** The gate: reads one line from its pipe, then runs Chrome on the same stdio and exit code. */
const gateScript = `
const { connect } = require("node:net");
const { spawn } = require("node:child_process");
const args = process.argv.slice(1);
if (args[0] === "--") args.shift();
const [gate, executable, ...rest] = args;
let line = "";
const socket = connect(gate);
socket.on("error", () => process.exit(1));
socket.on("data", (chunk) => { line += chunk; });
socket.on("close", () => {
  if (!line.startsWith("go")) process.exit(1);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, rest, { stdio: ["ignore", "ignore", "inherit", 3, 4], env, windowsHide: true });
  child.on("error", () => process.exit(1));
  child.on("exit", (code) => process.exit(code ?? 1));
});
`;

/** A one-shot named pipe: `open` lets the waiting gate start Chrome; `close` never does. */
function startGate(): { path: string; open(): void; close(): void } {
  const path = `\\\\.\\pipe\\ace-chrome-gate-${randomUUID()}`;
  let opened = false;
  let closed = false;
  let waiting: Socket | undefined;
  const server = createServer((socket) => {
    socket.on("error", () => {});
    server.close();
    if (closed) socket.destroy();
    else if (opened) socket.end("go\r\n");
    else waiting = socket;
  });
  server.maxConnections = 1;
  server.unref();
  // A failed pipe leaves the gate's read empty, so Chrome never starts uncontained.
  server.on("error", () => {});
  server.listen(path);
  return {
    path,
    open() {
      if (opened || closed) return;
      opened = true;
      waiting?.end("go\r\n");
    },
    close() {
      closed = true;
      server.close();
      if (!opened) waiting?.destroy();
    },
  };
}

export interface ChromeJobPorts {
  spawn: ProcessSpawner;
  createJob?: () => RetainedJob;
  /** The Node that runs the gate; default this process's. */
  node?: string;
  /** How long a stopped tree may take to empty its job; default 5 s. */
  emptyWithinMs?: number;
  /** A tree that outlived its browser, or a job that could not be released. */
  report?(error: Error): void;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Ends whatever is left in `job`, proves it empty within the bound, then releases it. */
async function release(job: RetainedJob, withinMs: number): Promise<void> {
  try {
    if (job.activeCount() > 0) job.terminate();
  } catch (error) {
    // A job that emptied meanwhile cannot be terminated; that is still a stopped tree.
    if (job.activeCount() > 0) throw error;
  }
  for (const deadline = performance.now() + withinMs; job.activeCount() > 0;) {
    if (performance.now() >= deadline)
      throw new Error("ace's Chrome processes survived their browser on Windows");
    await pause(25);
  }
  job.dispose();
}

/** Required job containment for ace's Chrome on Windows: the launch's `guard`, `spawn` and kill. */
export function chromeJobs(
  ports: ChromeJobPorts,
): Pick<ChromeLaunch, "guard" | "spawn"> & { kill(pid: number): Promise<void> } {
  const createJob = ports.createJob ?? (() => createRetainedJob());
  const withinMs = ports.emptyWithinMs ?? 5_000;
  const jobs = new Map<string, RetainedJob>();
  const byPid = new Map<number, RetainedJob>();
  return {
    guard: async (profile) => {
      const job = createJob();
      jobs.set(profile, job);
      return {
        close: async () => {
          if (jobs.get(profile) === job) jobs.delete(profile);
          for (const [pid, owner] of byPid) if (owner === job) byPid.delete(pid);
          try {
            await release(job, withinMs);
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            ports.report?.(failure);
            throw failure;
          }
        },
      };
    },
    spawn: (command, args, options) => {
      const profile = args.find((arg) => arg.startsWith(profileFlag))?.slice(profileFlag.length);
      const job = profile === undefined ? undefined : jobs.get(profile);
      if (!job) throw new Error("ace's Chrome has no job to run in on Windows");
      const gate = startGate();
      let child: ReturnType<ProcessSpawner>;
      try {
        child = ports.spawn(
          ports.node ?? process.execPath,
          ["-e", gateScript, "--", gate.path, command, ...args],
          { ...options, env: { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: "1" } },
        );
      } catch (error) {
        gate.close();
        throw error;
      }
      try {
        if (child.pid === undefined) throw new Error("ace's Chrome gate did not start");
        job.assign(child.pid);
        byPid.set(child.pid, job);
      } catch (error) {
        // Never opened, the gate exits without starting Chrome.
        gate.close();
        child.kill();
        throw error;
      }
      gate.open();
      return child;
    },
    /** Ends a browser's whole tree through its job; the guard's close then proves it empty. */
    kill: async (pid) => {
      const job = byPid.get(pid);
      if (!job) throw new Error("No Windows job owns this browser");
      try {
        job.terminate();
      } catch (error) {
        if (job.activeCount() > 0) throw error;
      }
    },
  };
}
