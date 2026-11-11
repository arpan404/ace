import { join } from "node:path";
import { z } from "zod";
import type { DeviceScope, SpadeMethod } from "@ace/protocol";

export {
  checkLivePath,
  checkSpadePath,
  readSpadeTokenFile as readTokenFile,
  type PathCheck,
} from "@ace/service/spade";

/** Decisions the Spade host makes, with no I/O (ADR 0121). */

export interface Backoff {
  baseMs: number;
  maxMs: number;
  /** A run that stayed ready this long counts as healthy: the next failure starts over. */
  healthyMs: number;
}
export const defaultBackoff: Backoff = { baseMs: 1000, maxMs: 60_000, healthyMs: 60_000 };

/** Delay before the restart that follows `failures` consecutive failures (1 or more). */
export function restartDelay(failures: number, backoff: Backoff = defaultBackoff): number {
  const exponent = Math.max(0, Math.min(failures - 1, 30));
  return Math.min(backoff.baseMs * 2 ** exponent, backoff.maxMs);
}

/** Consecutive failures after a run ends; `readyForMs` is how long it was ready, if it was. */
export function failuresAfterExit(
  previous: number,
  readyForMs: number | undefined,
  backoff: Backoff = defaultBackoff,
): number {
  return readyForMs !== undefined && readyForMs >= backoff.healthyMs ? 1 : previous + 1;
}

const ServerFile = z.object({
  address: z.string().max(64),
  pid: z.number().int().positive(),
  version: z.string().max(64),
});
export interface SpadeEndpoint {
  host: string;
  port: number;
  version: string;
}
/**
 * Spade's `server.json`, accepted only when it names the child the daemon started and a
 * loopback address: a stale file from an earlier run, or one naming another host, is not ready.
 */
export function readServerFile(text: string, childPid: number): SpadeEndpoint | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = ServerFile.safeParse(value);
  if (!parsed.success || parsed.data.pid !== childPid) return undefined;
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(parsed.data.address);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { host: "127.0.0.1", port, version: parsed.data.version };
}

/** `GET` reads; every other method changes something. */
export function scopeFor(method: SpadeMethod): DeviceScope {
  return method === "GET" ? "read" : "operate";
}

/**
 * Where the Spade binary is: `ACE_SPADE_BIN` in development, else `spade-server` beside the
 * runtime in the release bundle (`bin/node`, `bin/spade-server`). Undefined: Spade is off.
 */
export function findSpadeBinary(input: {
  env: Readonly<Record<string, string | undefined>>;
  runtimeDirectory: string;
  platform: NodeJS.Platform;
  isExecutable(path: string): boolean;
}): string | undefined {
  const override = input.env.ACE_SPADE_BIN?.trim();
  if (override) return input.isExecutable(override) ? override : undefined;
  const bundled = join(
    input.runtimeDirectory,
    input.platform === "win32" ? "spade-server.exe" : "spade-server",
  );
  return input.isExecutable(bundled) ? bundled : undefined;
}

/** Words for a run that ended, for `spade.status` and the log. */
export function exitReason(exit: { code: number | null; signal: string | null }): string {
  if (exit.code === 3) return "Another Spade is already running for this ace home.";
  if (exit.code === null && exit.signal === null) return "Spade couldn't be started.";
  if (exit.signal) return `Spade stopped on signal ${exit.signal}.`;
  return `Spade exited with code ${exit.code ?? "unknown"}.`;
}
