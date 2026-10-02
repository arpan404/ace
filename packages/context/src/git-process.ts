import { spawnRawSupervised, type RawSupervisedProcess } from "@ace/provider-kit/process";
import { z } from "zod";
import { ContextError } from "./errors.ts";
export interface GitProcessOptions {
  spawn?: typeof spawnRawSupervised;
  signal?: AbortSignal;
  timeoutMs?: number;
}
/** I/O owner: every success, overflow, cancellation and timeout awaits reaping. */
export async function withGit<T>(
  root: string,
  args: readonly string[],
  options: GitProcessOptions,
  consume: (process: RawSupervisedProcess) => Promise<T>,
): Promise<{ code: number; value: T }> {
  const timeout = z
    .number()
    .int()
    .positive()
    .max(300000)
    .parse(options.timeoutMs ?? 30000);
  if (options.signal?.aborted) throw new ContextError("busy", "Git operation cancelled");
  const child = (options.spawn ?? spawnRawSupervised)({
    command: "git",
    args: ["-C", root, ...args],
    env: {},
    name: "context-git",
  });
  child.stderr.resume();
  let failure: ContextError | undefined;
  const stop = (message: string) => {
    failure ??= new ContextError("busy", message);
    void child.stop({ graceMs: 0 });
  };
  const cancel = () => stop("Git operation cancelled");
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => stop("Git operation timed out"), timeout);
  try {
    const value = await consume(child);
    const exit = await child.exited;
    if (failure) throw failure;
    return { code: exit.code ?? -1, value };
  } catch (error) {
    // Cancellation can interrupt a NUL frame. Preserve its cause rather than
    // misreporting the truncated frame as malformed Git output.
    throw failure ?? error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    await child.stop({ graceMs: 0 });
  }
}
