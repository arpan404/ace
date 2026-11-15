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

/** The daemon's identity from its home's `host-id` text; undefined for anything else. */
export function parseHostIdFile(text: string): string | undefined {
  const parsed = HostIdFile.safeParse(text);
  return parsed.success ? parsed.data : undefined;
}

async function readHostId(home: string): Promise<string | undefined> {
  try {
    return parseHostIdFile(await readFile(join(home, "host-id"), "utf8"));
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

/** A daemon's admission: whether it is closed, and what holds it closed (newer daemons). */
export interface AdmissionFacts {
  draining: boolean;
  holds?: readonly string[] | undefined;
}

/**
 * One status request's answer. Newer daemons give the host token their admission with it, so a
 * health check needs no second request; older ones omit it.
 */
export type Health = { healthy: false } | { healthy: true; admission?: AdmissionFacts };

/** Asks the daemon's authenticated status endpoint once. */
export async function daemonHealth(daemon: LocalDaemon, timeoutMs = 3_000): Promise<Health> {
  try {
    const { DaemonHealth } = await protocol();
    const parsed = DaemonHealth.safeParse(await request(daemon, "/v1/status", { timeoutMs }));
    if (!parsed.success) return { healthy: false };
    const { admission } = parsed.data;
    return admission
      ? {
          healthy: true,
          admission: {
            draining: admission.draining,
            ...(admission.holds ? { holds: admission.holds } : {}),
          },
        }
      : { healthy: true };
  } catch {
    return { healthy: false };
  }
}

/** True when the daemon answers its authenticated status endpoint. */
export async function healthy(daemon: LocalDaemon, timeoutMs = 3_000): Promise<boolean> {
  return (await daemonHealth(daemon, timeoutMs)).healthy;
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
/** The update's own hold on admission (`/v1/maintenance/update`); the person's pause is apart. */
export async function setUpdateHold(daemon: LocalDaemon, on: boolean): Promise<number> {
  const { MaintenanceStatus } = await protocol();
  const result = MaintenanceStatus.parse(
    await request(daemon, "/v1/maintenance/update", { method: on ? "POST" : "DELETE" }),
  );
  return result.blockers;
}
export async function maintenanceBlockers(daemon: LocalDaemon): Promise<number> {
  const { MaintenanceStatus } = await protocol();
  return MaintenanceStatus.parse(await request(daemon, "/v1/maintenance")).blockers;
}

/**
 * Tells the daemon this app's update status (host token only), for its paired clients to read.
 * The reply may ask the app to download or install (ADR 0113); an older daemon's reply has no
 * instruction, and one that doesn't parse is treated the same.
 */
export async function reportAppUpdate(
  daemon: LocalDaemon,
  report: import("@ace/protocol").AppUpdateReport,
): Promise<import("@ace/protocol").AppUpdateReply | undefined> {
  const response = await fetch(new URL("/v1/app-update", daemon.origin), {
    method: "PUT",
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { AppUpdateReply } = await protocol();
  return AppUpdateReply.safeParse(await response.json().catch(() => undefined)).data;
}

/** Takes this app's update report back (host token only), as the app quits. */
export async function withdrawAppUpdate(daemon: LocalDaemon): Promise<void> {
  const response = await fetch(new URL("/v1/app-update", daemon.origin), {
    method: "DELETE",
    headers: { authorization: `Bearer ${daemon.token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

/** Authoritative admission state of the daemon now serving this endpoint. */
export async function maintenanceStatus(daemon: LocalDaemon) {
  const { MaintenanceStatus } = await protocol();
  return MaintenanceStatus.parse(await request(daemon, "/v1/maintenance"));
}
