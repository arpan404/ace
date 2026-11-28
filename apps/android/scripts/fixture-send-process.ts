import { spawnRawSupervised, type RawSupervisedProcess } from "@ace/provider-kit/process";

// Thin adaptation over the PUBLIC @ace/provider-kit/process ownership
// (detached group leaders, group TERM/KILL escalation, aggregate byte
// budgets). This helper owns only its tracked handles, timeout mapping and
// capture; it implements no spawn/group-signal logic of its own. HTTP fetch
// streaming stays here (not a process concern). Node scripts only: app `src`
// must never import provider-kit. Requires the parent-authorized
// `@ace/provider-kit` devDependency on apps/android (manifest amendment).

export const MAX_STREAM_BYTES = 256 * 1024;
const KILL_GRACE_MS = 2000;

export type ProcResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
};

export class ProcTimeoutError extends Error {}
export class ProcKilledError extends Error {}

type Tracked = { proc: RawSupervisedProcess; killedBy: string | undefined };
const tracked = new Set<Tracked>();
const ownedFetches = new Set<AbortController>();

/** Bounded capture on the public supervised-process owner. */
export function runBounded(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<ProcResult> {
  return new Promise<ProcResult>((resolve, reject) => {
    let proc: RawSupervisedProcess;
    try {
      proc = spawnRawSupervised({
        command,
        args,
        env: process.env,
        name: "fixture-send",
        maxOutputBytes: MAX_STREAM_BYTES,
      });
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error("spawn failed"));
      return;
    }
    const entry: Tracked = { proc, killedBy: undefined };
    tracked.add(entry);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const settleResolve = (value: ProcResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tracked.delete(entry);
      resolve(value);
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tracked.delete(entry);
      reject(error);
    };
    // Read-only invocations never write: EOF stdin so a CLI waiting on
    // stdin exits instead of hanging until the timeout.
    proc.stdin.end();
    proc.stdout.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) out.push(chunk);
    });
    proc.stderr.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) err.push(chunk);
    });
    const timer = setTimeout(
      () => {
        entry.killedBy = "timeout";
        void proc.stop({ graceMs: KILL_GRACE_MS }).then(
          () => {
            settleReject(new ProcTimeoutError(`timeout: ${command} ${args.join(" ")}`));
          },
          (error: unknown) => {
            settleReject(error instanceof Error ? error : new ProcTimeoutError("stop failed"));
          },
        );
      },
      Math.max(1, timeoutMs),
    );
    timer.unref();
    void proc.exited.then((exit) => {
      if (entry.killedBy === "timeout") return; // Timeout path settles.
      if (entry.killedBy !== undefined) {
        settleReject(new ProcKilledError(`child killed (${entry.killedBy}): ${command}`));
        return;
      }
      settleResolve({
        exitCode: exit.code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        truncated: exit.reason === "output-limit",
        timedOut: false,
      });
    });
  });
}

/** Stop all owned groups (TERM, KILL stragglers) and await every exit. */
export async function killOwnedChildren(reason: string): Promise<void> {
  const entries = [...tracked];
  for (const entry of entries) entry.killedBy = entry.killedBy ?? reason;
  await Promise.all(
    entries.map((entry) =>
      entry.proc.stop({ graceMs: KILL_GRACE_MS }).then(
        () => undefined,
        () => undefined,
      ),
    ),
  );
}

/** Abort all owned in-flight fetches. */
export function abortOwnedFetches(): void {
  for (const controller of ownedFetches) {
    try {
      controller.abort();
    } catch {
      // Own controllers only.
    }
  }
}

/**
 * Stream the response body and cancel once wire bytes exceed the cap;
 * the body is never buffered unbounded before the check.
 */
export async function fetchTextCapped(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  ownedFetches.add(controller);
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
    if (response.body === null) throw new Error(`empty body: ${url}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Own reader only.
        }
        throw new Error(`response over cap: ${url}`);
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
    ownedFetches.delete(controller);
  }
}
