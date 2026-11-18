import { PairingRequest, type DeviceScope } from "@ace/protocol";
import { pairingLinkUrl } from "@ace/client/access";
import { AccessError, type RemoteAuth } from "./remote-auth.ts";
import { hostedWebOrigin } from "./web-origins.ts";

/**
 * Where a redeeming device reaches this daemon: its own HTTPS address and the TLS key it pins,
 * or a self-hosted relay and the host key it pins there.
 */
export type PairingConnection =
  | {
      origin: string;
      fingerprint: string;
      relay?: undefined;
      /** The person's own relay the daemon is also on: a second way in (ADR 0182). */
      alsoRelay?: { url: string; hostId: string } | undefined;
    }
  | { relay: { url: string; hostId: string }; origin?: undefined; fingerprint?: undefined };
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
 * With `app`, the link opens that web app and names this daemon in its fragment. `person`: the
 * creator is proven to be the person (ADR 0178 §12.8), and so is the device the link pairs.
 */
export function issuePairing(
  auth: RemoteAuth,
  connection: PairingConnection | undefined,
  input: unknown,
  holds: (scope: DeviceScope) => boolean,
  person: boolean,
  app?: string,
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
  const { id, code, expiresAt } = auth.pairing(scopes, { label, ttlMs, deviceTtlMs, person });
  const url = connection.relay
    ? // No address of its own to open: the link opens ace's web app (or the chosen one).
      pairingLinkUrl({ relay: connection.relay, code, scopes, app: app ?? hostedWebOrigin })
    : pairingLinkUrl({
        daemon: connection.origin,
        fingerprint: connection.fingerprint,
        code,
        scopes,
        app,
        alsoRelay: connection.alsoRelay,
      });
  return { id, url, code, expiresAt };
}
