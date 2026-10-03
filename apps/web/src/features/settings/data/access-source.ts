/*
 * Paired devices, pairing and revoking through the daemon's HTTP access routes (`AccessClient`):
 * `GET /v1/devices`, `POST /v1/pairings`, `DELETE /v1/devices/:id`, with the admin token in the
 * Authorization header. Fake mode reaches the fake daemon's routes through an injected fetch.
 */
import { AccessClient, ClientError, type AccessOptions } from "@ace/client";
import type { Device, DeviceScope } from "@ace/protocol";
import type { DaemonEndpoint } from "@/boot/connection.tsx";
import type { AccessGaps } from "./access-gaps.ts";
import type { Pairing } from "./backend.ts";

export type { AcpAgentInstall } from "./access-gaps.ts";

export interface AccessSource extends AccessGaps {
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

/** A failed access call, in words a person can act on. */
function explain(error: unknown, origin: string): Error {
  if (error instanceof ClientError && error.code === "daemon") {
    if (error.message === "HTTP 409")
      return new Error(
        "Remote access is off. Restart the daemon with ACE_LISTEN=lan or ACE_LISTEN=tailscale.",
      );
    if (error.message === "HTTP 401" || error.message === "HTTP 403")
      return new Error("Only the daemon's own token can manage paired devices.");
    if (error.message === "HTTP 404") return new Error("That device is no longer paired.");
  }
  if (error instanceof ClientError && error.code === "auth")
    return new Error("Paired devices need a wss:// address or one on 127.0.0.1.");
  if (error instanceof TypeError) return new Error(`Couldn't reach the daemon at ${origin}.`);
  return error instanceof Error ? error : new Error("The daemon refused that.");
}

function options(endpoint: DaemonEndpoint): AccessOptions {
  if (endpoint.kind === "fake") return endpoint.access;
  const { url, token } = endpoint.target;
  return {
    origin: accessOrigin(url),
    fetch: (input, init) => fetch(input, init),
    token: async () => token,
  };
}

/** Access for this connection; `gaps` serves what the daemon has no route for yet. */
export function accessSource(endpoint: DaemonEndpoint | undefined, gaps: AccessGaps): AccessSource {
  const settings = endpoint && options(endpoint);
  const origin = settings?.origin ?? "";
  let client: AccessClient | undefined;
  const run = async <T>(call: (client: AccessClient) => Promise<T>): Promise<T> => {
    try {
      if (!settings) throw new Error("Connect to a daemon first.");
      client ??= new AccessClient(settings);
      return await call(client);
    } catch (error) {
      throw explain(error, origin);
    }
  };
  return {
    ...gaps,
    devices: () =>
      run((access) => access.devices()).then((all) =>
        all.filter((device) => device.revokedAt === null),
      ),
    pair: (scopes) =>
      run((access) => access.pairing(scopes.filter((scope) => scope !== "desktop"))).then(pairing),
    revoke: (deviceId) => run((access) => access.revoke(deviceId)).then(() => undefined),
  };
}
