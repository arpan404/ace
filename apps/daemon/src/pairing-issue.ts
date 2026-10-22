import { PairingRequest, type DeviceScope } from "@ace/protocol";
import { AccessError, type RemoteAuth } from "./remote-auth.ts";

/** Where a redeeming device reaches this daemon, and the TLS key it pins. */
export interface PairingConnection {
  origin: string;
  fingerprint: string;
}
export interface IssuedPairing {
  id: string;
  url: string;
  code: string;
  expiresAt: number;
}

const scopeNames: Record<DeviceScope, string> = {
  read: "Read",
  operate: "Operate",
  admin: "Admin",
  projects: "Projects",
  accounts: "Accounts",
  desktop: "Desktop",
  "user-browser": "Use my Chrome",
};

/**
 * One pairing link, as `POST /v1/pairings` and `fleet.request` issue it. The creator may grant
 * only scopes it holds itself (`holds`): `projects` and `accounts` are separate grants from admin
 * (ADR 0070). The code and fingerprint travel in the URL fragment, which no HTTP request carries.
 */
export function issuePairing(
  auth: RemoteAuth,
  connection: PairingConnection | undefined,
  input: unknown,
  holds: (scope: DeviceScope) => boolean,
): IssuedPairing {
  if (!connection)
    throw new AccessError(
      409,
      "Turn on remote access in Settings, then choose LAN or Tailscale to pair.",
    );
  const parsed = PairingRequest.safeParse(input);
  if (!parsed.success) throw new AccessError(400, "Invalid scopes");
  const { scopes: requested, label, ttlMs, deviceTtlMs } = parsed.data;
  const scopes = [...new Set(requested)];
  const missing = scopes.find((scope) => !holds(scope));
  if (missing)
    throw new AccessError(
      403,
      `You can't grant ${scopeNames[missing]}: this device doesn't have it.`,
    );
  const { id, code, expiresAt } = auth.pairing(scopes, { label, ttlMs, deviceTtlMs });
  const url = new URL("/pair", connection.origin);
  url.hash = new URLSearchParams({
    fingerprint: connection.fingerprint,
    code,
    scopes: scopes.join(","),
  }).toString();
  return { id, url: url.toString(), code, expiresAt };
}
