import { asBuffer, type BunSpawner, type BunSubprocess } from "./bun-spawn.ts";
import type { ProbeExit, ProbeStart } from "./probe-messages.ts";
import { killGroup, registerGroup, unregisterGroup } from "./process-owner.ts";

export interface StartedProbe {
  readonly pid?: number;
  /** Settles once the process and its pipes are gone. */
  readonly exit: Promise<ProbeExit>;
  /** Kill the probe's whole process group; reported as `stopped`. */
  stop(): void;
}

const failedToStart: ProbeExit = {
  code: null,
  signal: null,
  reason: "spawn-error",
  stdout: "",
  stderr: "",
};

/**
 * A bounded, read-only CLI probe started with `Bun.spawn` (macOS and Linux). It is owned the way
 * a supervised spawn is: it leads its own process group, registered with this isolate's process
 * owner from the moment it has a pid; the whole group is killed when the leader exits, when the
 * output passes `maxBytes`, and on `stop`. Stdin is closed at once.
 */
export function startBunProbe(spawner: BunSpawner, request: ProbeStart): StartedProbe {
  let child: BunSubprocess;
  try {
    child = spawner.spawn([request.command, ...request.args], {
      env: request.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return { exit: Promise.resolve(failedToStart), stop() {} };
  }
  const { pid } = child;
  let ended = false;
  let stopped = false;
  let limited = false;
  const destroy = () => {
    try {
      killGroup(pid, "SIGKILL");
    } catch {
      // A group this process can no longer signal is not one it can stop.
    }
  };
  const stop = () => {
    // Once the leader is reaped its pid can be reused: never signal it again.
    if (ended) return;
    stopped = true;
    destroy();
  };
  try {
    void Promise.resolve(child.stdin.end()).catch(() => {});
  } catch {
    // A probe that already closed its stdin has nothing left to wait for there.
  }
  let bytes = 0;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        if (bytes > request.maxBytes) {
          limited = true;
          destroy();
          break;
        }
        chunks.push(asBuffer(chunk));
      }
    } catch {
      // A pipe that fails ends this probe's output; the exit still reports what happened.
    }
    return Buffer.concat(chunks).toString();
  };
  const stdout = read(child.stdout);
  const stderr = read(child.stderr);
  const exit = child.exited.then(async (): Promise<ProbeExit> => {
    // Descendants never outlive the probe's leader.
    destroy();
    ended = true;
    unregisterGroup(pid);
    const [out, err] = await Promise.all([stdout, stderr]);
    const signal = child.signalCode;
    return {
      code: child.exitCode,
      signal,
      reason: limited ? "output-limit" : stopped ? "stopped" : signal ? "signal" : "exit",
      stdout: out,
      stderr: err,
    };
  });
  // A journal that cannot record the group kills it before this throws.
  registerGroup(
    pid,
    () => {
      stop();
      return exit;
    },
    { name: "cli-probe" },
    destroy,
  );
  return { pid, exit, stop };
}
