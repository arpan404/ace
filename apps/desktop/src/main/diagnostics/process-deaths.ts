import type { Log, LogData } from "../log/desktop-log.ts";

/** Electron's `child-process-gone` details: a GPU, network service or other helper. */
export interface ChildProcessGone {
  type: string;
  reason: string;
  exitCode: number;
  serviceName?: string | undefined;
  name?: string | undefined;
  systemErrorCode?: number | undefined;
}

/** Electron's `render-process-gone` details. */
export interface RendererProcessGone {
  reason: string;
  exitCode: number;
}

export interface ProcessDeathsOptions {
  log: Log;
  now(): number;
  /** Crash dumps written at or after `since` (epoch ms), newest first. */
  dumps(since: number): Promise<readonly string[]>;
  schedule(callback: () => void, delayMs: number): void;
}

/** A dump modified this long before the death is still taken to be its dump. */
const DUMP_SLACK_MS = 10_000;
/** Crashpad may finish writing after Electron reports the death; one later look. */
const DUMP_RECHECK_MS = 5_000;

/**
 * Writes every process death the app sees to the desktop log: Electron's helpers (GPU,
 * network service, utilities) and the renderers of the app's windows. A clean exit is an
 * info record; a crash, kill, OOM or failed launch is an error, with the crash dump Crashpad
 * wrote for it, when there is one. A dump is credited to one death only.
 */
export function processDeaths(options: ProcessDeathsOptions) {
  const credited = new Set<string>();
  async function newDump(since: number): Promise<string | undefined> {
    try {
      const found = (await options.dumps(since)).find((path) => !credited.has(path));
      if (found) credited.add(found);
      return found;
    } catch {
      return undefined;
    }
  }
  async function record(message: string, reason: string, data: LogData): Promise<void> {
    if (reason === "clean-exit") {
      options.log("info", message, data);
      return;
    }
    const since = options.now() - DUMP_SLACK_MS;
    const minidump = await newDump(since);
    options.log("error", message, minidump ? { ...data, minidump } : data);
    if (minidump) return;
    options.schedule(() => {
      void newDump(since).then((late) => {
        if (late)
          options.log("info", `Crash dump written: ${message}`, { ...data, minidump: late });
      });
    }, DUMP_RECHECK_MS);
  }
  return {
    child(details: ChildProcessGone): Promise<void> {
      const label = details.name ?? details.serviceName ?? details.type;
      return record(`${label} process gone: ${details.reason}`, details.reason, {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName ?? null,
        name: details.name ?? null,
        ...(details.systemErrorCode === undefined
          ? {}
          : { systemErrorCode: details.systemErrorCode }),
      });
    },
    /** `window` names what the renderer drew: `main` (the app window), `secondary`, `browser`. */
    renderer(window: string, details: RendererProcessGone): Promise<void> {
      return record(`${window} renderer gone: ${details.reason}`, details.reason, {
        window,
        reason: details.reason,
        exitCode: details.exitCode,
      });
    },
  };
}
