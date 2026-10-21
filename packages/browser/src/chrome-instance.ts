import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import type { BrowserCdp } from "./backend.ts";
import { CdpConnection, type CdpIntercept, type Schedule } from "./cdp-connection.ts";
import { chromeArgs } from "./chrome-flags.ts";
import { ChromeTargets } from "./chrome-targets.ts";
import type { ProcessSpawner } from "./io.ts";
import { pipeTransport } from "./pipe-transport.ts";

export interface ChromeCleanup {
  /** Graceful `Browser.close` budget before the process group is killed. */
  timeoutMs: number;
  schedule: Schedule;
  kill(pid: number): void | Promise<void>;
  onTimeout?(message: string): void;
}
export interface ChromeLaunch {
  args: readonly string[];
  deviceScaleFactor: number;
  /** A host with no sessions exits after this long. */
  idleMs: number;
  startTimeoutMs: number;
  commandTimeoutMs: number;
  spawn: ProcessSpawner;
  /** Owns the profile's processes if the daemon dies; resolves once watching. */
  guard(profileDir: string): Promise<{ close(): Promise<void> }>;
  intercept?: CdpIntercept;
  /**
   * Explains a failed start from Chrome's stderr and the machine (missing libraries, a blocked
   * sandbox); returns the error to throw. Absent: the bare failure.
   */
  diagnose?(failure: ChromeStartFailure): Promise<Error>;
}
export interface ChromeStartFailure {
  executable: string;
  /** The start and end of Chrome's stderr. */
  stderr: string;
  error: Error;
}
export interface ChromeInstanceOptions {
  executable: string;
  profileDir: string;
  stagingDir: string;
  platform: NodeJS.Platform;
  launch: ChromeLaunch;
  cleanup: ChromeCleanup;
}

/** One Chrome process and its pipe. `exited` settles with a reason however it ends. */
export interface ChromeInstance {
  readonly pid: number;
  readonly connection: CdpConnection;
  readonly root: BrowserCdp;
  readonly targets: ChromeTargets;
  readonly stagingDir: string;
  readonly exited: Promise<string>;
  /** Closes Chrome, force-killing it at the cleanup deadline. Idempotent. */
  stop(): Promise<void>;
}

export async function launchChrome(options: ChromeInstanceOptions): Promise<ChromeInstance> {
  const { launch, cleanup } = options;
  await rm(options.stagingDir, { recursive: true, force: true });
  await mkdir(options.stagingDir, { recursive: true, mode: 0o700 });
  await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
  const guardian = await launch.guard(options.profileDir);
  let child: ReturnType<ProcessSpawner>;
  try {
    child = launch.spawn(
      options.executable,
      chromeArgs({
        profileDir: options.profileDir,
        deviceScaleFactor: launch.deviceScaleFactor,
        platform: options.platform,
        extra: launch.args,
      }),
      {
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        detached: options.platform !== "win32",
        windowsHide: true,
      },
    );
    await Promise.race([
      once(child, "spawn"),
      once(child, "error").then(([error]: unknown[]) => {
        throw error instanceof Error ? error : new Error("Chrome failed to start");
      }),
    ]);
  } catch (error) {
    await guardian.close().catch(() => {});
    throw new Error(
      `Chrome failed to start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  // Late process errors (a failed signal) must not become uncaught exceptions.
  child.on("error", () => {});
  const pid = child.pid;
  const input = child.stdio[3];
  const output = child.stdio[4];
  // Chrome's fatal line comes first and a stack trace after it: keep both ends.
  let stderrHead = "";
  let stderrTail = "";
  const stderrClosed = Promise.withResolvers<void>();
  const stderrStream = child.stdio[2];
  if (stderrStream) {
    stderrStream.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stderrHead.length < 4096) stderrHead = (stderrHead + text).slice(0, 4096);
      else stderrTail = (stderrTail + text).slice(-4096);
    });
    stderrStream.once("close", () => stderrClosed.resolve());
  } else stderrClosed.resolve();
  const stderr = () => (stderrTail ? `${stderrHead}\n...\n${stderrTail}` : stderrHead);
  const exit = Promise.withResolvers<string>();
  child.once("exit", (code, signal) =>
    exit.resolve(
      signal ? `The browser stopped (${signal})` : `The browser exited with code ${code ?? 0}`,
    ),
  );
  const kill = async () => {
    if (pid !== undefined) await cleanup.kill(pid);
  };
  if (pid === undefined || !(input instanceof Writable) || !(output instanceof Readable)) {
    child.kill("SIGKILL");
    await exit.promise;
    await guardian.close().catch(() => {});
    throw new Error("Chrome failed to start: debugging pipe unavailable");
  }
  let hungReason: string | undefined;
  let stopping: Promise<void> | undefined;
  const connection: CdpConnection = new CdpConnection({
    write: (message) => transport.send(message),
    schedule: cleanup.schedule,
    commandTimeoutMs: launch.commandTimeoutMs,
    hung: (reason) => {
      hungReason = reason;
      void kill().catch(() => {});
    },
    ...(launch.intercept ? { intercept: launch.intercept } : {}),
  });
  const transport = pipeTransport(input, output, {
    message: (text) => connection.receive(text),
    // A broken pipe leaves Chrome unreachable; it must not outlive its transport.
    closed: () => {
      if (!stopping && child.exitCode === null && child.signalCode === null)
        void kill().catch(() => {});
    },
  });
  const targets = new ChromeTargets(connection, cleanup.schedule);
  const exited = exit.promise.then(async (reason) => {
    const final = hungReason ?? reason;
    connection.close(final);
    targets.stop(final);
    transport.close();
    await guardian.close().catch(() => {});
    return final;
  });
  const stop = () =>
    (stopping ??= (async () => {
      let cancel: (() => void) | undefined;
      const forced = new Promise<void>((resolve) => {
        cancel = cleanup.schedule(() => {
          void (async () => {
            try {
              await kill();
              report(`Chromium cleanup exceeded ${cleanup.timeoutMs}ms; force-killed browser`);
            } catch (error) {
              report(
                `Chromium cleanup exceeded ${cleanup.timeoutMs}ms; termination failed: ${String(error)}`,
              );
            } finally {
              resolve();
            }
          })();
        }, cleanup.timeoutMs);
      });
      void connection.send("Browser.close").catch(() => {});
      try {
        await Promise.race([exited, forced]);
      } finally {
        cancel?.();
      }
      await exited;
    })());
  const report = (message: string) => {
    try {
      cleanup.onTimeout?.(message);
    } catch {
      /* Observers cannot fail teardown. */
    }
  };
  try {
    await connection.send("Browser.getVersion", undefined, { timeoutMs: launch.startTimeoutMs });
    await targets.start(options.stagingDir);
  } catch (error) {
    await kill().catch(() => {});
    await exited;
    // Chrome's last words can arrive after its exit; wait for them briefly.
    let cancelWait: (() => void) | undefined;
    await Promise.race([
      stderrClosed.promise,
      new Promise<void>((resolve) => (cancelWait = cleanup.schedule(resolve, 1_000))),
    ]);
    cancelWait?.();
    const written = stderr();
    const detail = stderrSummary(written);
    const failure = new Error(
      `Chrome failed to start: ${error instanceof Error ? error.message : String(error)}${detail ? ` (${detail})` : ""}`,
      { cause: error },
    );
    throw launch.diagnose
      ? await launch
          .diagnose({ executable: options.executable, stderr: written, error: failure })
          .catch(() => failure)
      : failure;
  }
  return {
    pid,
    connection,
    root: connection.session(""),
    targets,
    stagingDir: options.stagingDir,
    exited,
    stop,
  };
}

/** The line that says why Chrome stopped, else its last lines. */
function stderrSummary(output: string): string {
  const lines = output.trim().split("\n");
  const cause = lines.find((line) => /FATAL|error while loading|Running as root/.test(line));
  return (cause ?? lines.slice(-3).join(" ")).slice(0, 1024);
}
