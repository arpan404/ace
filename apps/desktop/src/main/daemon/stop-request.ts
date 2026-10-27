import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readLocalDaemon } from "./probe.ts";

const LockOwner = z.object({ pid: z.number().int().positive() });

/** The pid in the home's `daemon-lock`, or undefined when there is no readable one. */
export async function lockOwner(home: string): Promise<number | undefined> {
  try {
    const parsed = LockOwner.safeParse(
      JSON.parse((await readFile(join(home, "daemon-lock"), "utf8")).slice(0, 256)),
    );
    return parsed.success ? parsed.data.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Asks the daemon `pid` serving `home` to shut down (`POST /v1/stop`, as `ace stop` does).
 * Windows needs this because Node's `kill("SIGTERM")` there is `TerminateProcess`, which skips
 * the daemon's own shutdown (ADR 0095). Only a daemon whose lock names `pid` is asked, so a
 * daemon this app did not start is never stopped. False when the request was not accepted:
 * the caller then ends the process itself.
 */
export async function requestStop(home: string, pid: number, timeoutMs = 3_000): Promise<boolean> {
  if ((await lockOwner(home)) !== pid) return false;
  const daemon = await readLocalDaemon(home);
  if (!daemon) return false;
  try {
    const response = await fetch(new URL("/v1/stop", daemon.origin), {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const Maintenance = z.object({ blockers: z.number().int().nonnegative() });

/**
 * Threads still at work in the daemon `pid` serving `home` (the maintenance lease's blockers),
 * or undefined when that daemon does not answer or the lock names another process.
 */
export async function daemonBusy(
  home: string,
  pid: number,
  timeoutMs = 3_000,
): Promise<number | undefined> {
  if ((await lockOwner(home)) !== pid) return undefined;
  const daemon = await readLocalDaemon(home);
  if (!daemon) return undefined;
  try {
    const response = await fetch(new URL("/v1/maintenance", daemon.origin), {
      headers: { authorization: `Bearer ${daemon.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const parsed = Maintenance.safeParse(await response.json());
    return parsed.success ? parsed.data.blockers : undefined;
  } catch {
    return undefined;
  }
}
