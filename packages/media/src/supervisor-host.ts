import { randomBytes } from "node:crypto";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import {
  connectLane,
  nodeByteSink,
  nodeByteSource,
  type ByteSink,
  type ByteSource,
  type LaneSocket,
} from "./lanes.ts";

/** What the supervisor needs from the world, and the real implementations of it. */

export interface MediaChild {
  readonly pid?: number | undefined;
  readonly stdin: ByteSink;
  readonly stdout: ByteSource;
  readonly stderr: ByteSource;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /** SIGKILL, or TerminateProcess through the job object. */
  kill(): void;
}
export interface MediaHost {
  spawn(binary: string): MediaChild;
  connect(path: string): Promise<LaneSocket>;
}
export interface MediaClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): () => void;
}

/** The real host: ace-media as an owned child process, its lanes over `node:net`. */
export function nodeMediaHost(
  env: NodeJS.ProcessEnv,
  launch: (binary: string) => { command: string; args: string[] } = (binary) => ({
    command: binary,
    args: [],
  }),
): MediaHost {
  return {
    spawn(binary) {
      const { command, args } = launch(binary);
      const child = spawnRawSupervised({ command, args, env, name: "ace-media" });
      return {
        pid: child.pid,
        stdin: nodeByteSink(child.stdin),
        stdout: nodeByteSource(child.stdout),
        stderr: nodeByteSource(child.stderr),
        exited: child.exited.then(({ code, signal }) => ({ code, signal })),
        kill: () => void child.stop({ graceMs: 0 }),
      };
    },
    connect: connectLane,
  };
}

/** The wall clock and timers, for the daemon. */
export const systemMediaClock: MediaClock = {
  now: () => performance.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

/** The platform CSPRNG: the lane secret comes from here unless a test injects its own. */
export function secureRandomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}
