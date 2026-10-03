import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonHealth, MaintenanceStatus } from "@ace/protocol";
import { z } from "zod";

/** What a daemon publishes in its ACE_HOME for local clients (`ace status` reads the same). */
export interface LocalDaemon {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** `ws://127.0.0.1:<port>/` */
  url: string;
  token: string;
}

const Origin = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/";
  })
  .transform((value) => new URL(value).origin);
const Token = z.string().regex(/^[0-9a-f]{64}$/);

/** Reads the endpoint and token files. Missing or malformed files mean "no daemon here". */
export async function readLocalDaemon(home: string): Promise<LocalDaemon | undefined> {
  try {
    const [endpoint, token] = await Promise.all([
      readFile(join(home, "daemon-endpoint"), "utf8"),
      readFile(join(home, "daemon-token"), "utf8"),
    ]);
    const origin = Origin.parse(endpoint.trim());
    return { origin, url: origin.replace(/^http:/, "ws:") + "/", token: Token.parse(token.trim()) };
  } catch {
    return undefined;
  }
}

async function request(
  daemon: LocalDaemon,
  path: string,
  init: { method?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  const response = await fetch(new URL(path, daemon.origin), {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${daemon.token}` },
    signal: AbortSignal.timeout(init.timeoutMs ?? 3_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** True when the daemon answers its authenticated status endpoint. */
export async function healthy(daemon: LocalDaemon, timeoutMs = 3_000): Promise<boolean> {
  try {
    return DaemonHealth.safeParse(await request(daemon, "/v1/status", { timeoutMs })).success;
  } catch {
    return false;
  }
}

/** Finds a healthy daemon in ACE_HOME, if one is already running there. */
export async function findRunningDaemon(home: string): Promise<LocalDaemon | undefined> {
  const daemon = await readLocalDaemon(home);
  return daemon && (await healthy(daemon)) ? daemon : undefined;
}

/**
 * Maintenance lease (ADR 0041): entering closes admission for new work and reports how many
 * threads are still busy; running turns, approvals and background tasks finish naturally.
 */
export async function setMaintenance(daemon: LocalDaemon, on: boolean): Promise<number> {
  const result = MaintenanceStatus.parse(
    await request(daemon, "/v1/maintenance", { method: on ? "POST" : "DELETE" }),
  );
  return result.blockers;
}
export async function maintenanceBlockers(daemon: LocalDaemon): Promise<number> {
  return MaintenanceStatus.parse(await request(daemon, "/v1/maintenance")).blockers;
}
