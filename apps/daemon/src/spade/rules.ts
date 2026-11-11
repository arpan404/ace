import { z } from "zod";
import type { DeviceScope, SpadeMethod } from "@ace/protocol";

export {
  checkLivePath,
  checkSpadePath,
  readSpadeTokenFile as readTokenFile,
  type PathCheck,
} from "@ace/service/spade";

/** Decisions the daemon makes about Spade's service, with no I/O (ADR 0123). */

/** What the service manager says about Spade's registration (`@ace/service`). */
export type SpadeServiceState = "absent" | "stopped" | "running";

/** Spade's HTTP API versions this daemon speaks: the current one and the one before. */
const spadeApis = new Set([1]);
const ServerFile = z.object({
  address: z.string().max(64),
  pid: z.number().int().positive(),
  version: z.string().max(64),
  /** Absent from Spade builds before the API was versioned; those speak version 1. */
  api: z.number().int().optional(),
});
export interface SpadeEndpoint {
  host: string;
  port: number;
  pid: number;
  version: string;
}
/**
 * Spade's `server.json`, accepted only when it names a loopback address and an API version this
 * daemon speaks. Whether that Spade is still running is `/health`'s to say.
 */
export function readServerFile(text: string): SpadeEndpoint | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = ServerFile.safeParse(value);
  if (!parsed.success || !spadeApis.has(parsed.data.api ?? 1)) return undefined;
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(parsed.data.address);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { host: "127.0.0.1", port, pid: parsed.data.pid, version: parsed.data.version };
}

/** What the daemon last saw of Spade. */
export interface SpadeFacts {
  enabled: boolean;
  /** The registration, or why it couldn't be read. */
  service: SpadeServiceState | { error: string };
  /** Why turning Spade on failed (installing the binary, registering the service). */
  problem?: string | undefined;
  /** The daemon is installing the binary or registering the service right now. */
  installing?: boolean;
  /** From `server.json` and the token file, when both read and its pid is alive. */
  endpoint?: SpadeEndpoint | undefined;
  /** `/health` answered `ok` at `endpoint`. */
  healthy: boolean;
  /** Whether that answer proved it holds the token file's token (`proof.ts`). */
  proof?: "ok" | "missing" | "wrong" | undefined;
  /** How long Spade has been registered and running without answering. */
  silentForMs: number;
}
/** How long a running service may take to answer before Spade counts as failed. */
export const spadeStartGraceMs = 15_000;
export type SpadeState =
  | { state: "off"; reason?: string }
  | { state: "starting" }
  | { state: "ready"; version: string }
  | { state: "failed"; reason: string };

/** Whether the facts show Spade itself answering: only then is its token or grant sent. */
export function spadeAnswering(facts: SpadeFacts): boolean {
  return (
    facts.enabled &&
    !facts.problem &&
    facts.service === "running" &&
    facts.endpoint !== undefined &&
    facts.healthy &&
    facts.proof === "ok"
  );
}

/**
 * `spade.status` from the facts (contract, "Other clients"): `off` while disabled or with no
 * service registered, `ready` once the registered, running Spade answers `/health` with a valid
 * proof, `starting` until then, and `failed` with the reason when the service is registered but
 * Spade isn't answering, or something other than Spade answers at its address.
 */
export function spadeState(facts: SpadeFacts): SpadeState {
  if (!facts.enabled) return { state: "off" };
  if (facts.problem) return { state: "failed", reason: facts.problem };
  if (typeof facts.service === "object")
    return { state: "failed", reason: `Spade's service couldn't be read: ${facts.service.error}` };
  if (facts.installing && facts.service !== "running") return { state: "starting" };
  if (facts.service === "absent")
    return { state: "off", reason: "Spade's service isn't registered on this machine." };
  if (facts.service === "stopped")
    return { state: "failed", reason: "Spade's service is registered but not running." };
  const { endpoint } = facts;
  if (spadeAnswering(facts) && endpoint) return { state: "ready", version: endpoint.version };
  if (endpoint && facts.healthy)
    return {
      state: "failed",
      reason: `Something at ${endpoint.host}:${endpoint.port} answers for Spade but can't prove it is Spade (${facts.proof === "wrong" ? "wrong" : "no"} proof); nothing was sent to it.`,
    };
  if (facts.installing || facts.silentForMs < spadeStartGraceMs) return { state: "starting" };
  return {
    state: "failed",
    reason: endpoint
      ? `Spade isn't answering at ${endpoint.host}:${endpoint.port}.`
      : "Spade's service is running but Spade hasn't started listening.",
  };
}

/** `GET` reads; every other method changes something. */
export function scopeFor(method: SpadeMethod): DeviceScope {
  return method === "GET" ? "read" : "operate";
}
