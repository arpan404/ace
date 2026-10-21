import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { digestLogLines, type TriageContext } from "@ace/diagnostics/triage";
import { createTextRedactor, isSecretKey } from "@ace/redaction";
import type { InstalledCli } from "./triage-launch.ts";

const TAIL_BYTES = 512 * 1024;
const RunFile = z.object({ state: z.string(), pid: z.number().int().positive() }).loose();

/** Read the end of the log without loading a file that may be gigabytes. */
export async function readLogTail(file: string, bytes = TAIL_BYTES): Promise<string[]> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    // The first line is partial unless the read began at the file's start.
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

/** Whether ace's own daemon owns this data folder right now. */
export async function localDaemonState(
  dataDir: string,
  alive: (pid: number) => boolean = processAlive,
): Promise<"running" | "stopped"> {
  const text = await readFile(join(dataDir, "daemon-run.json"), "utf8").catch(() => undefined);
  if (!text) return "stopped";
  try {
    const run = RunFile.safeParse(JSON.parse(text));
    return run.success && run.data.state === "running" && alive(run.data.pid)
      ? "running"
      : "stopped";
  } catch {
    return "stopped";
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Everything the handoff prompt says about this computer, redacted before it leaves. */
export async function collectTriageContext(input: {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  home: string;
  now: number;
  environment: string;
  clis: readonly InstalledCli[];
  /** Earlier failures; this function adds its own and never throws for a bad read. */
  problems?: readonly string[];
}): Promise<TriageContext> {
  const logFile = join(input.dataDir, "logs", "ace.jsonl");
  const problems = [...(input.problems ?? [])];
  const [lines, daemon] = await Promise.all([
    readLogTail(logFile).catch((error: unknown) => {
      problems.push(`Reading ${logFile} failed: ${message(error)}`);
      return [];
    }),
    localDaemonState(input.dataDir).catch((error: unknown) => {
      problems.push(`Reading the daemon's run state failed: ${message(error)}`);
      return undefined;
    }),
  ]);
  // Scrub secrets, ids and emails, but keep paths usable: the agent runs on this computer.
  const scrub = createTextRedactor({
    home: input.home,
    env: Object.fromEntries(Object.entries(input.env).filter(([key]) => isSecretKey(key))),
  });
  const redact = (text: string) => scrub(text).replaceAll("<HOME>", "~");
  const tilde = (path: string) =>
    path === input.home || path.startsWith(`${input.home}/`)
      ? `~${path.slice(input.home.length)}`
      : path;
  const logs = digestLogLines(lines, { now: input.now });
  for (const entry of logs) {
    entry.message = redact(entry.message);
    if (entry.sample) entry.sample = redact(entry.sample);
  }
  return {
    environment: input.environment,
    ...(daemon ? { daemon } : {}),
    clis: input.clis.map((cli) => ({
      label: cli.label,
      ...(cli.version ? { version: cli.version } : {}),
    })),
    dataDir: tilde(input.dataDir),
    logFile: tilde(logFile),
    logs,
    now: input.now,
    ...(problems.length ? { problems: problems.map(redact) } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "failed";
}
