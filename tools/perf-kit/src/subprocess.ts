import type { ChildProcess, ExecFileOptions } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import { TimingFailure } from "./timing.ts";

const Deadline = z.object({
  killed: z.literal(true),
  // Buffer overflows have a string code even when they also kill with SIGTERM.
  code: z.number().int().nullable(),
  signal: z.literal("SIGTERM").nullable(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
const FailureMarker = z.object({ type: z.enum(["acceptance.failed", "measurement.failed"]) });
const MissingFile = z.object({ code: z.literal("ENOENT") });

function hasFailureMarker(stderr: string): boolean {
  return stderr.split("\n").some((line) => {
    try {
      return FailureMarker.safeParse(JSON.parse(line)).success;
    } catch {
      return false;
    }
  });
}

type Runner = (
  file: string,
  args: string[],
  options: ExecFileOptions & { encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

/** Thin subprocess boundary. The caller owns the executable, spawner and deadline. */
export async function runTimed(
  run: Runner,
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer?: number },
  publish: (stdout: string) => void = () => {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run(file, args, { ...options, encoding: "utf8" });
  } catch (error) {
    const deadline = Deadline.safeParse(error);
    if (!deadline.success || hasFailureMarker(deadline.data.stderr ?? "")) throw error;
    if (deadline.data.stdout) publish(deadline.data.stdout);
    throw new TimingFailure(`subprocess exceeded its ${options.timeout} ms deadline`, {
      cause: error,
    });
  }
}

/** Publish the pending failure synchronously, before any awaited cleanup can hide it. */
export async function measureWithCleanup<T>(
  measure: () => Promise<T>,
  cleanup: () => Promise<void>,
  publish: (marker: string) => void,
): Promise<T> {
  try {
    return await measure();
  } catch (error) {
    if (!(error instanceof TimingFailure))
      publish(JSON.stringify({ type: "measurement.failed", error: String(error) }));
    throw error;
  } finally {
    await cleanup().catch((error: unknown) => {
      publish(JSON.stringify({ type: "measurement.failed", error: String(error) }));
      throw error;
    });
  }
}

/** Resource failures must remain fatal even when the same sample misses timing. */
export function checkBudgets(
  resources: readonly string[],
  timing: readonly string[],
  deadline?: TimingFailure,
): void {
  if (resources.length) throw new Error(resources.join("\n"));
  if (deadline) throw deadline;
  if (timing.length) throw new TimingFailure(timing.join("\n"));
}

/** A new attempt owns a new result: no incomplete attempt may inherit old data. */
export async function readFreshMeasurement(
  output: string,
  measure: () => Promise<unknown>,
): Promise<{ raw: string; deadline?: TimingFailure }> {
  await rm(output, { force: true });
  let deadline: TimingFailure | undefined;
  try {
    await measure();
  } catch (error) {
    if (!(error instanceof TimingFailure)) throw error;
    deadline = error;
  }
  const raw = await readFile(output, "utf8").catch((error: unknown) => {
    if (deadline && MissingFile.safeParse(error).success) throw deadline;
    throw error;
  });
  return deadline ? { raw, deadline } : { raw };
}

/** Do not remove served files or start another preview until its owner has exited. */
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
