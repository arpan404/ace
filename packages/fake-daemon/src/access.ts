import {
  Device,
  PairingRedemption,
  PairingRequest,
  PendingPairing,
  type RemoteAccessStatus,
} from "@ace/protocol";
import { settingsFixture } from "./scenarios/settings.ts";

const pairingLifetimeMs = 5 * 60_000;
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The daemon's HTTP access routes in memory: `GET /v1/devices`, `POST /v1/pairings` and
 * `DELETE /v1/devices/:id`, admin token required, same status codes and bodies. `fetch` plugs
 * into `AccessClient`, so fake mode and tests run the client's real parsing and limits.
 */
export class FakeAccess {
  private devices: Device[];
  remoteStatus: () => RemoteAccessStatus;
  private clock: () => number;
  private pairings = 0;
  /** Open links by code; the latest is the one `completePairing` redeems. */
  private pending = new Map<string, PendingPairing>();
  /** The administrator token these routes accept (a daemon token is 64 hex characters). */
  readonly token = "ace0".repeat(16);
  constructor(
    clock: () => number,
    remoteStatus: () => RemoteAccessStatus = () => ({
      enabled: true,
      transport: "tailscale",
      listenOverride: null,
      relayOverride: false,
    }),
  ) {
    this.clock = clock;
    this.remoteStatus = remoteStatus;
    this.devices = settingsFixture(clock()).devices;
  }
  /** Paired devices that are still allowed in, as `GET /v1/devices` lists them. */
  list(): Device[] {
    return this.devices.filter((device) => device.revokedAt === null);
  }
  private code(): string {
    let n = ++this.pairings * 7_919 + 104_729;
    const letters: string[] = [];
    for (let index = 0; index < 8; index++) {
      letters.push(codeAlphabet[n % codeAlphabet.length] ?? "A");
      n = Math.floor(n / codeAlphabet.length) + index * 31;
    }
    return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
  }
  /** A single-use link, as the daemon issues one: the code and fingerprint ride in the fragment. */
  pair(input: unknown): { id: string; url: string; code: string; expiresAt: number } {
    const request = PairingRequest.parse(input);
    const scopes = [...new Set(request.scopes)];
    const code = this.code();
    const id = `pairing-${this.pairings}`;
    const expiresAt = this.clock() + (request.ttlMs ?? pairingLifetimeMs);
    this.pending.set(
      code,
      PendingPairing.parse({
        id,
        scopes,
        expiresAt,
        label: request.label,
        deviceTtlMs: request.deviceTtlMs ?? undefined,
      }),
    );
    const fragment = new URLSearchParams({
      fingerprint: "5f1c9a7e",
      code,
      scopes: scopes.join(","),
    });
    return {
      id,
      code,
      url: `https://studio-mac.tailnet.ts.net:7417/pair#${fragment.toString()}`,
      expiresAt,
    };
  }
  /** Links not yet used or expired, without their codes. */
  pendingPairings(): PendingPairing[] {
    const at = this.clock();
    return [...this.pending.values()].filter((entry) => entry.expiresAt > at);
  }
  /** False when no open link has that id. */
  cancelPairing(id: string): boolean {
    for (const [code, entry] of this.pending)
      if (entry.id === id) {
        this.pending.delete(code);
        return true;
      }
    return false;
  }
  private redeem(code: string, name: string): Device | undefined {
    const entry = this.pending.get(code);
    this.pending.delete(code);
    return entry && entry.expiresAt > this.clock() ? this.admit(entry, name) : undefined;
  }
  private admit(
    entry: Pick<PendingPairing, "scopes" | "label" | "deviceTtlMs">,
    name: string,
  ): Device {
    const at = this.clock();
    const device = Device.parse({
      id: `device-${this.pairings}-${this.devices.length + 1}`,
      name: entry.label ?? name,
      scopes: entry.scopes,
      createdAt: at,
      lastSeenAt: at,
      revokedAt: null,
      expiresAt: entry.deviceTtlMs ? at + entry.deviceTtlMs : null,
    });
    this.devices = [...this.devices, device];
    return device;
  }
  /** A device scans the latest code (dev and tests): it appears in `GET /v1/devices`. */
  completePairing(name: string): Device {
    const latest = [...this.pending].at(-1);
    if (latest) this.pending.delete(latest[0]);
    return this.admit(latest?.[1] ?? { scopes: ["read", "operate"] }, name);
  }
  revoke(id: string): boolean {
    const at = this.clock();
    if (!this.list().some((device) => device.id === id)) return false;
    this.devices = this.devices.map((device) =>
      device.id === id ? Device.parse({ ...device, revokedAt: at }) : device,
    );
    return true;
  }
  /** Revoke every paired device but `keep` and local credentials; returns how many. */
  revokeOthers(keep: string | undefined): number {
    const others = this.list().filter(
      (device) =>
        device.id !== keep &&
        !device.scopes.includes("desktop") &&
        !device.scopes.includes("user-browser"),
    );
    for (const device of others) this.revoke(device.id);
    return others.length;
  }
  /** A `fetch` that answers the access routes on any origin. */
  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(input).pathname;
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    if (path === "/v1/pair" && method === "POST") {
      const parsed = PairingRedemption.safeParse(
        typeof init.body === "string" ? JSON.parse(init.body) : {},
      );
      if (!parsed.success) return reply(400, { error: "Invalid pairing" });
      const device = this.redeem(parsed.data.code, parsed.data.name);
      if (!device) return reply(401, { error: "Expired pairing" });
      return reply(200, { device, token: "b".repeat(64) });
    }
    if (headers.get("authorization") !== `Bearer ${this.token}`)
      return reply(401, { error: "Administrator token required" });
    if (path === "/v1/status")
      return reply(200, {
        remoteAccess: this.remoteStatus(),
      });
    if (path === "/v1/devices" && method === "GET") return reply(200, this.list());
    if (path === "/v1/pairings" && method === "POST") {
      const remote = this.remoteStatus();
      if (!remote.enabled || !["lan", "tailscale"].includes(remote.transport))
        return reply(409, { error: "Remote access unavailable" });
      const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (!PairingRequest.safeParse(body).success) return reply(400, { error: "Invalid scopes" });
      const { id, url, expiresAt } = this.pair(body);
      return reply(200, { id, url, expiresAt });
    }
    if (path.startsWith("/v1/devices/") && method === "DELETE")
      return this.revoke(decodeURIComponent(path.slice("/v1/devices/".length)))
        ? reply(200, { revoked: true })
        : reply(404, { error: "Active device not found" });
    return reply(404, { error: "Unknown endpoint" });
  };
}
