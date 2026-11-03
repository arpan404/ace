/*
 * Remote access status, paired devices, pairing and revoking over the machine's own connection
 * (`fleet.request`, admin only, the same daemon code as `GET /v1/status`, `GET /v1/devices`,
 * `POST /v1/pairings` and `DELETE /v1/devices/:id`). `accessOptions` is the HTTP route left for
 * what only this computer's own credential may do (machine-account-source.ts).
 */
import { ClientError, type AccessOptions, type ClientApi } from "@ace/client";
import {
  DeviceId,
  type Device,
  type DeviceScope,
  type FleetOperation,
  type FleetOutcome,
} from "@ace/protocol";
import type { DaemonEndpoint } from "@/boot/connection.tsx";
import type { AccessGaps } from "./access-gaps.ts";
import type { Pairing } from "./backend.ts";

export type { AcpAgentInstall } from "./access-gaps.ts";

export interface AccessSource extends AccessGaps {
  remoteStatus(): Promise<import("@ace/protocol").RemoteAccessStatus>;
  devices(): Promise<Device[]>;
  pair(scopes: DeviceScope[]): Promise<Pairing>;
  revoke(deviceId: string): Promise<void>;
}

/** The daemon's HTTP origin for its WebSocket address: same host and port, http(s). */
export function accessOrigin(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${url.origin}/`;
}

/** What a pairing URL carries in its fragment: the one-time code, also typed by hand. */
export function pairing(response: { url: string; expiresAt: number }): Pairing {
  const code = new URLSearchParams(new URL(response.url).hash.slice(1)).get("code") ?? "";
  return { url: response.url, code, expiresAt: response.expiresAt };
}

/**
 * A phone or browser a person paired and can revoke. The daemon also lists its own local
 * credentials: the desktop app's embedded browser (`desktop`) and the "Use my Chrome" native host
 * (`user-browser`, revoked from Computer use), which are not paired devices.
 */
function paired(device: Device): boolean {
  return (
    device.revokedAt === null &&
    device.scopes.some((scope) => scope !== "desktop" && scope !== "user-browser")
  );
}

/** A refusal's code: the daemon's own (`forbidden`…) inside a `daemon` error, else the client's. */
function refusal(error: unknown): string {
  if (!(error instanceof ClientError)) return "";
  return error.code === "daemon" ? error.message : error.code;
}

/** A failed access call, in words a person can act on. */
function explain(error: unknown): Error {
  switch (refusal(error)) {
    case "forbidden":
      return new Error(
        "This device cannot manage pairing. Use the host computer or a device with administrator access.",
      );
    case "unavailable":
      return new Error("Turn on remote access above and choose LAN or Tailscale, then pair again.");
    case "not_found":
      return new Error("That device is no longer paired.");
    case "busy":
      return new Error("Too many pairing links are open. Cancel one first.");
    case "version_mismatch":
    case "protocol":
    case "invalid":
      return new Error("This machine runs another version of ace. Update it, then try again.");
    case "":
      return error instanceof Error
        ? error
        : new Error("This machine refused the request. Reconnect and try again.");
    default:
      return new Error("Couldn't reach this machine. Reconnect and try again.");
  }
}

const unreadable = () => new Error("This machine gave an answer ace can't read.");

/** How this window reaches its daemon's HTTP routes: origin, fetch and credential. */
export function accessOptions(endpoint: DaemonEndpoint): AccessOptions {
  if (endpoint.kind === "fake") return endpoint.access;
  const { url, token } = endpoint.target;
  return {
    origin: accessOrigin(url),
    fetch: (input, init) => fetch(input, init),
    token: async () => token,
  };
}

/**
 * Access for the machine `client` reaches, over its own connection (`fleet.request`), so it
 * works the same direct, through a self-hosted relay or as an account machine on ace's hosted
 * relay, and a machine's page never shows another machine's devices. `gaps` serves what the
 * daemon can't answer yet.
 */
export function accessSource(
  client: Pick<ClientApi, "request"> | undefined,
  gaps: AccessGaps,
): AccessSource {
  const run = async (operation: FleetOperation): Promise<FleetOutcome> => {
    try {
      if (!client) throw new Error("Connect to your computer first.");
      return (await client.request({ type: "fleet.request", operation })).result;
    } catch (error) {
      throw explain(error);
    }
  };
  return {
    ...gaps,
    async remoteStatus() {
      const result = await run({ op: "remoteStatus" });
      if (result.kind !== "remoteStatus") throw unreadable();
      return result.status;
    },
    async devices() {
      const result = await run({ op: "devices" });
      if (result.kind !== "devices") throw unreadable();
      return result.devices.filter(paired);
    },
    async pair(scopes) {
      const result = await run({
        op: "pairing",
        scopes: scopes.filter(
          (scope): scope is Exclude<typeof scope, "desktop" | "user-browser"> =>
            scope !== "desktop" && scope !== "user-browser",
        ),
      });
      if (result.kind !== "pairing") throw unreadable();
      return pairing(result);
    },
    async revoke(deviceId) {
      const result = await run({ op: "revoke", deviceId: DeviceId.parse(deviceId) });
      if (result.kind !== "revoked") throw unreadable();
    },
  };
}
