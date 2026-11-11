import { join } from "node:path";
import { z } from "zod";
import type { DeviceScope, SpadeMethod } from "@ace/protocol";

/** Decisions the Spade host makes, with no I/O (ADR 0117). */

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

/** Spade's token file: one line of visible ASCII, 16 to 4096 characters. */
export function readTokenFile(text: string): string | undefined {
  const token = text.trim();
  return /^[\x21-\x7e]{16,4096}$/.test(token) ? token : undefined;
}

export type PathCheck = { ok: true; path: string } | { ok: false; message: string };
const refuse = (message: string): PathCheck => ({ ok: false, message });
const allowedCharacters = /^[A-Za-z0-9\-._~/%?=&+,:@!$'()*;]+$/;
/**
 * A path the daemon forwards to Spade: `/v1/` and onwards, no dot segments, empty segments,
 * fragments or encoded separators, so a client can never reach `/health` or leave the API.
 */
export function checkSpadePath(path: string): PathCheck {
  if (path.length > 2048) return refuse("The path is too long.");
  if (!path.startsWith("/v1/")) return refuse("Spade paths start with /v1/.");
  if (!allowedCharacters.test(path)) return refuse("The path has characters Spade doesn't use.");
  const [pathname = "", ...rest] = path.split("?");
  if (rest.length > 1) return refuse("The path has more than one query.");
  if (/%(2e|2f|5c|00)/i.test(pathname)) return refuse("The path encodes a separator.");
  if (/%(?![0-9a-f]{2})/i.test(path)) return refuse("The path has a broken escape.");
  const segments = pathname.slice(1).split("/");
  if (segments.some((segment, index) => segment === "" && index < segments.length - 1))
    return refuse("The path has an empty segment.");
  if (segments.some((segment) => segment === "." || segment === ".."))
    return refuse("The path has a dot segment.");
  return { ok: true, path };
}

/** A live path: a Spade API path whose last segment is `live`. */
export function checkLivePath(path: string): PathCheck {
  const checked = checkSpadePath(path);
  if (!checked.ok) return checked;
  const pathname = path.split("?")[0] ?? "";
  return pathname.endsWith("/live")
    ? checked
    : { ok: false, message: "Live streams are /v1/.../live paths." };
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
