import { spawn } from "node:child_process";

/** A byte sink the supervisor writes frames into. False means the pipe is saturated. */
export interface FilesSink {
  write(chunk: Uint8Array): boolean;
  /** Called when a saturated pipe accepts writes again. */
  onDrain(listener: () => void): void;
}

/** A byte source the supervisor reads frames from. */
export interface FilesSource {
  onData(listener: (chunk: Uint8Array) => void): void;
}

/** How a child process ended. */
export interface FilesExit {
  code: number | null;
  signal: string | null;
}

/** One ace-files process, as the supervisor needs it. */
export interface FilesChild {
  readonly pid?: number | undefined;
  readonly stdin: FilesSink;
  readonly stdout: FilesSource;
  readonly stderr: FilesSource;
  readonly exited: Promise<FilesExit>;
  /**
   * SIGKILL on POSIX, TerminateProcess on Windows. There is no job object yet, so a process the
   * child started itself is not covered.
   */
  kill(): void;
}

/** Where processes come from; a test injects a fake. */
export interface FilesHost {
  spawn(binary: string): FilesChild;
}

/** Time and timers; a test injects a manual clock. */
export interface FilesClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): () => void;
}

export interface FilesLaunch {
  command: string;
  args: string[];
}

/**
 * The real host: ace-files as an owned child with pipes for both directions. `launch` lets a
 * test run a stand-in script through the runtime that is running the tests.
 */
export function nodeFilesHost(
  env: NodeJS.ProcessEnv,
  launch: (binary: string) => FilesLaunch = (binary) => ({ command: binary, args: [] }),
): FilesHost {
  return {
    spawn(binary) {
      const { command, args } = launch(binary);
      const child = spawn(command, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const exited = new Promise<FilesExit>((resolve) => {
        let settled = false;
        const settle = (exit: FilesExit) => {
          if (settled) return;
          settled = true;
          resolve(exit);
        };
        // `close` fires once both stdio pipes are drained, so a frame written just before the
        // child exited is still delivered before the run is declared over.
        child.once("close", (code, signal) => settle({ code, signal }));
        child.once("error", () => settle({ code: null, signal: null }));
      });
      // A broken pipe after the child dies is normal; it must never surface as an exception.
      child.stdin.on("error", () => {});
      child.stdout.on("error", () => {});
      child.stderr.on("error", () => {});
      return {
        pid: child.pid,
        stdin: {
          write(chunk) {
            return child.stdin.destroyed ? false : child.stdin.write(chunk);
          },
          onDrain(listener) {
            child.stdin.on("drain", listener);
          },
        },
        stdout: {
          onData(listener) {
            child.stdout.on("data", (chunk: Buffer) => listener(chunk));
          },
        },
        stderr: {
          onData(listener) {
            child.stderr.on("data", (chunk: Buffer) => listener(chunk));
          },
        },
        exited,
        kill() {
          child.kill("SIGKILL");
        },
      };
    },
  };
}

/** Wall time and real timers, for the daemon. */
export const systemFilesClock: FilesClock = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
