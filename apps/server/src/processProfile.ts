import { runProcess } from "./processRunner";

export interface ProcessProfileSample {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly cpuPercent: number | null;
  readonly cpuSecondsTotal: number | null;
  readonly executable: string;
  readonly command: string;
}

export interface ProcessProfileTreeSnapshot {
  readonly rootPid: number;
  readonly found: boolean;
  readonly processes: ReadonlyArray<ProcessProfileSample>;
  readonly totalRssBytes: number;
  readonly totalCpuPercent: number | null;
}

const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = `
$cpuById = @{}
Get-Process | ForEach-Object {
  if ($_.CPU -ne $null) {
    $cpuById[[int]$_.Id] = [double]$_.CPU
  }
}

$rows = Get-CimInstance Win32_Process | ForEach-Object {
  $pid = [int]$_.ProcessId
  $ppid = [int]$_.ParentProcessId
  $rss = if ($_.WorkingSetSize -ne $null) { [double]$_.WorkingSetSize } else { 0 }
  $command = if ($_.CommandLine) { [string]$_.CommandLine } else { [string]$_.Name }
  $cpu = if ($cpuById.ContainsKey($pid)) { [double]$cpuById[$pid] } else { $null }
  [PSCustomObject]@{
    pid = $pid
    ppid = $ppid
    rssBytes = $rss
    cpuSecondsTotal = $cpu
    executable = [string]$_.Name
    command = $command
  }
}
$rows | ConvertTo-Json -Compress
`;

function asNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function parseUnixProcessTable(stdout: string): ReadonlyArray<ProcessProfileSample> {
  const samples: ProcessProfileSample[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1] ?? "", 10);
    const ppid = Number.parseInt(match[2] ?? "", 10);
    const rssKb = Number.parseInt(match[3] ?? "", 10);
    const cpuPercent = Number.parseFloat(match[4] ?? "");
    const executable = (match[5] ?? "").trim();
    const args = (match[6] ?? "").trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(rssKb)) {
      continue;
    }

    samples.push({
      pid,
      ppid,
      rssBytes: Math.max(0, rssKb) * 1024,
      cpuPercent: Number.isFinite(cpuPercent) ? Math.max(0, cpuPercent) : null,
      cpuSecondsTotal: null,
      executable,
      command: args.length > 0 ? args : executable,
    });
  }
  return samples;
}

function normalizeJsonArray(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
    );
  }
  if (value && typeof value === "object") {
    return [value as Record<string, unknown>];
  }
  return [];
}

function parseWindowsProcessTable(stdout: string): ReadonlyArray<ProcessProfileSample> {
  const parsed = stdout.trim().length > 0 ? JSON.parse(stdout) : [];
  const rows = normalizeJsonArray(parsed);
  const samples: ProcessProfileSample[] = [];
  for (const row of rows) {
    const pid = asNonNegativeInt(row.pid);
    const ppid = asNonNegativeInt(row.ppid);
    if (pid <= 0) {
      continue;
    }
    const executable = asString(row.executable);
    const command = asString(row.command);
    samples.push({
      pid,
      ppid,
      rssBytes: asNonNegativeInt(asNumber(row.rssBytes)),
      cpuPercent: null,
      cpuSecondsTotal: asNumber(row.cpuSecondsTotal),
      executable: executable.length > 0 ? executable : "unknown",
      command:
        command.length > 0 ? command : executable.length > 0 ? executable : `pid:${String(pid)}`,
    });
  }
  return samples;
}

function isCommandNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const normalized = error.message.toLowerCase();
  return normalized.includes("command not found");
}

async function sampleUnixProcesses(): Promise<ReadonlyArray<ProcessProfileSample>> {
  const result = await runProcess("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,comm=,args="], {
    timeoutMs: 3_000,
    maxBufferBytes: 24 * 1024 * 1024,
    outputMode: "truncate",
  });
  return parseUnixProcessTable(result.stdout);
}

async function sampleWindowsProcesses(): Promise<ReadonlyArray<ProcessProfileSample>> {
  const powershellArgs = ["-NoProfile", "-Command", WINDOWS_PROCESS_SNAPSHOT_SCRIPT] as const;
  try {
    const result = await runProcess("powershell", powershellArgs, {
      timeoutMs: 6_000,
      maxBufferBytes: 24 * 1024 * 1024,
      outputMode: "truncate",
    });
    return parseWindowsProcessTable(result.stdout);
  } catch (error) {
    if (!isCommandNotFound(error)) {
      throw error;
    }
  }

  const result = await runProcess("pwsh", powershellArgs, {
    timeoutMs: 6_000,
    maxBufferBytes: 24 * 1024 * 1024,
    outputMode: "truncate",
  });
  return parseWindowsProcessTable(result.stdout);
}

export async function sampleProcessTable(): Promise<ReadonlyArray<ProcessProfileSample>> {
  if (process.platform === "win32") {
    return await sampleWindowsProcesses();
  }
  return await sampleUnixProcesses();
}

export function deriveCpuPercentsFromCpuSeconds(input: {
  readonly samples: ReadonlyArray<ProcessProfileSample>;
  readonly previousCpuSecondsByPid: ReadonlyMap<number, number>;
  readonly elapsedMs: number;
  readonly cpuCoreCount: number;
}): {
  readonly samples: ReadonlyArray<ProcessProfileSample>;
  readonly nextCpuSecondsByPid: Map<number, number>;
} {
  const elapsedSeconds = input.elapsedMs / 1_000;
  const cpuCoreCount = Math.max(1, Math.floor(input.cpuCoreCount));
  const nextCpuSecondsByPid = new Map<number, number>();

  const samples = input.samples.map((sample) => {
    if (sample.cpuSecondsTotal === null) {
      return sample;
    }
    nextCpuSecondsByPid.set(sample.pid, sample.cpuSecondsTotal);
    if (elapsedSeconds <= 0) {
      return sample;
    }
    const previousCpuSeconds = input.previousCpuSecondsByPid.get(sample.pid);
    if (previousCpuSeconds === undefined) {
      return sample;
    }
    const cpuDelta = Math.max(0, sample.cpuSecondsTotal - previousCpuSeconds);
    const cpuPercent = (cpuDelta / elapsedSeconds / cpuCoreCount) * 100;
    return {
      ...sample,
      cpuPercent: Number.isFinite(cpuPercent)
        ? Math.max(0, Math.round(cpuPercent * 10) / 10)
        : null,
    };
  });

  return {
    samples,
    nextCpuSecondsByPid,
  };
}

export function buildProcessTree(
  samples: ReadonlyArray<ProcessProfileSample>,
  rootPid: number,
): ProcessProfileTreeSnapshot {
  const byPid = new Map<number, ProcessProfileSample>(
    samples.map((sample) => [sample.pid, sample]),
  );
  const root = byPid.get(rootPid);
  if (!root) {
    return {
      rootPid,
      found: false,
      processes: [],
      totalRssBytes: 0,
      totalCpuPercent: null,
    };
  }

  const childPidsByParent = new Map<number, Array<number>>();
  for (const sample of samples) {
    const children = childPidsByParent.get(sample.ppid);
    if (children) {
      children.push(sample.pid);
      continue;
    }
    childPidsByParent.set(sample.ppid, [sample.pid]);
  }

  const queue: number[] = [rootPid];
  const visited = new Set<number>();
  const treeSamples: ProcessProfileSample[] = [];
  let totalRssBytes = 0;
  let totalCpuPercent = 0;
  let hasCpuPercent = false;

  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || visited.has(pid)) {
      continue;
    }
    visited.add(pid);

    const sample = byPid.get(pid);
    if (!sample) {
      continue;
    }
    treeSamples.push(sample);
    totalRssBytes += sample.rssBytes;
    if (sample.cpuPercent !== null) {
      totalCpuPercent += sample.cpuPercent;
      hasCpuPercent = true;
    }

    const children = childPidsByParent.get(pid);
    if (children) {
      queue.push(...children);
    }
  }

  treeSamples.sort((left, right) => {
    if (left.pid === rootPid) {
      return -1;
    }
    if (right.pid === rootPid) {
      return 1;
    }
    if (right.rssBytes !== left.rssBytes) {
      return right.rssBytes - left.rssBytes;
    }
    return left.pid - right.pid;
  });

  return {
    rootPid,
    found: true,
    processes: treeSamples,
    totalRssBytes,
    totalCpuPercent: hasCpuPercent ? Math.round(totalCpuPercent * 10) / 10 : null,
  };
}
