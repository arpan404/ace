import { accessSync, constants, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSupervised } from "@ace/provider-kit/process";
import { spadeHealthy } from "./forward.ts";
import type { SpadeHostRuntime } from "./host.ts";

/** Longest Spade output line copied into the daemon's log. */
const maxLoggedLine = 4096;

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The host's real edges: Spade runs as an owned process group through the shared supervisor
 * (journaled, so a crashed daemon's Spade is cleaned up on the next start), with its output in
 * the daemon's log tagged `spade`.
 */
export function nodeSpadeRuntime(input: {
  /**
   * The daemon's environment. Spade inherits it (PATH, HOME, the person's own `SPADE_*`
   * settings) except ace's own `ACE_*` variables; the host's variables are set over it.
   */
  env: NodeJS.ProcessEnv;
  now(): number;
  output(stream: "stdout" | "stderr", line: string): void;
}): SpadeHostRuntime {
  const inherited = Object.fromEntries(
    Object.entries(input.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("ACE_"),
    ),
  );
  const log = (stream: "stdout" | "stderr") => (line: string) =>
    input.output(stream, line.length > maxLoggedLine ? `${line.slice(0, maxLoggedLine)}…` : line);
  return {
    spawn({ command, env }) {
      const child = spawnSupervised({
        command,
        env: { ...inherited, ...env },
        name: "spade",
        maxLineBytes: 1024 * 1024,
      });
      child.stdout.on("line", log("stdout"));
      child.stderr.on("line", log("stderr"));
      return {
        get pid() {
          return child.pid;
        },
        exited: child.exited.then((exit) => ({ code: exit.code, signal: exit.signal })),
        stop: (graceMs) => child.stop({ graceMs }),
      };
    },
    async readText(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    ensureDirectory(path) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    healthy: (endpoint, signal) => spadeHealthy(endpoint, signal),
    now: input.now,
    sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    },
  };
}
