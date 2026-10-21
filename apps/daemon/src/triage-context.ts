import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { digestLogLines, type TriageFacts } from "@ace/diagnostics/triage";
import { createTextRedactor, isSecretKey } from "@ace/redaction";
import type { DiagnosticReport } from "@ace/protocol";
import type { InstalledCli } from "./triage-launch.ts";

const TAIL_BYTES = 512 * 1024;
const RunFile = z.object({ state: z.string(), pid: z.number().int().positive() }).loose();
/** Credentials and identities inside the ace folder. The agent is told never to open them. */
const SECRET_ENTRIES = [
  "daemon-token",
  "tls",
  "account-homes",
  "browser",
  "chromium",
  "mcp-enrollments",
] as const;

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

/**
 * Everything the facts file says about this computer, redacted. Never throws for a bad
 * read: each failure becomes a line under "Couldn't check".
 */
export async function collectTriageFacts(input: {
  dataDir: string;
  sourceCache: string;
  env: NodeJS.ProcessEnv;
  home: string;
  now: number;
  cliVersion: string;
  launchedFrom: string;
  clis: readonly InstalledCli[];
  report?: DiagnosticReport;
  problems?: readonly string[];
}): Promise<TriageFacts> {
  const logFile = join(input.dataDir, "logs", "ace.jsonl");
  const problems = [...(input.problems ?? [])];
  const note = (what: string) => (error: unknown) => {
    problems.push(`${what}: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}`);
    return undefined;
  };
  const [lines, daemon, entries] = await Promise.all([
    readLogTail(logFile).catch(note(`Reading ${logFile} failed`)),
    localDaemonState(input.dataDir).catch(note("Reading the daemon's run state failed")),
    readdir(input.dataDir).catch(note(`Listing ${input.dataDir} failed`)),
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
  const logs = digestLogLines(lines ?? [], { now: input.now });
  for (const entry of logs) {
    entry.message = redact(entry.message);
    if (entry.sample) entry.sample = redact(entry.sample);
  }
  const findings = input.report?.checks
    .filter((check) => check.status !== "ok")
    .map((check) => ({ id: check.id, status: check.status, message: redact(check.message) }));
  return {
    collectedAt: new Date(input.now).toISOString(),
    cliVersion: input.cliVersion,
    os: `${process.platform} ${process.arch}`,
    node: process.version,
    launchedFrom: tilde(input.launchedFrom),
    ...(daemon ? { daemon } : {}),
    clis: input.clis.map((cli) => ({
      label: cli.label,
      ...(cli.version ? { version: cli.version } : {}),
    })),
    paths: {
      data: tilde(input.dataDir),
      log: tilde(logFile),
      settings: tilde(join(input.dataDir, "settings.json")),
      databases: (entries ?? [])
        .filter((name) => name.endsWith(".sqlite"))
        .toSorted()
        .map((name) => tilde(join(input.dataDir, name))),
      sourceCache: tilde(input.sourceCache),
    },
    secrets: SECRET_ENTRIES.map((name) => tilde(join(input.dataDir, name))),
    logs,
    ...(findings?.length ? { findings } : {}),
    problems: problems.map(redact),
    now: input.now,
  };
}
