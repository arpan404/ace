import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** What a daemon publishes in its ACE_HOME for local clients (`ace status` reads the same). */
export interface LocalDaemon {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** `ws://127.0.0.1:<port>/` */
  url: string;
  token: string;
  /**
   * The home's `host-id`: the identity this daemon welcomes clients with. Read with the token
   * on every connect, so the app trusts the current home and never one it remembered. Absent
   * only when the file is missing or unreadable.
   */
  hostId?: string;
}

const Origin = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/";
  })
  .transform((value) => new URL(value).origin);
const Token = z.string().regex(/^[0-9a-f]{64}$/);
/** As the daemon writes it (a UUID, untrimmed); anything else is not trusted as an identity. */
const HostIdFile = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/);

async function readHostId(home: string): Promise<string | undefined> {
  try {
    const parsed = HostIdFile.safeParse(await readFile(join(home, "host-id"), "utf8"));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the endpoint, token and host-id files. A missing or malformed endpoint or token means
 * "no daemon here".
 */
export async function readLocalDaemon(home: string): Promise<LocalDaemon | undefined> {
  try {
    const [endpoint, token, hostId] = await Promise.all([
      readFile(join(home, "daemon-endpoint"), "utf8"),
      readFile(join(home, "daemon-token"), "utf8"),
      readHostId(home),
    ]);
    const origin = Origin.parse(endpoint.trim());
    return {
      origin,
      url: origin.replace(/^http:/, "ws:") + "/",
      token: Token.parse(token.trim()),
      ...(hostId ? { hostId } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The protocol's schemas are most of the main process's code; they load with the first probe,
 * which runs after the window is created, not with the app.
 */
const protocol = () => import("@ace/protocol");

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
    const { DaemonHealth } = await protocol();
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
  const { MaintenanceStatus } = await protocol();
  const result = MaintenanceStatus.parse(
    await request(daemon, "/v1/maintenance", { method: on ? "POST" : "DELETE" }),
  );
  return result.blockers;
}
export async function maintenanceBlockers(daemon: LocalDaemon): Promise<number> {
  const { MaintenanceStatus } = await protocol();
  return MaintenanceStatus.parse(await request(daemon, "/v1/maintenance")).blockers;
}

/** Authoritative admission state of the daemon now serving this endpoint. */
export async function maintenanceStatus(daemon: LocalDaemon) {
  const { MaintenanceStatus } = await protocol();
  return MaintenanceStatus.parse(await request(daemon, "/v1/maintenance"));
}
