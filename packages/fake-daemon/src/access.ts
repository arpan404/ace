import { Device, PairingRedemption, PairingRequest, type DeviceScope } from "@ace/protocol";
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
  private clock: () => number;
  private pairings = 0;
  private pending: { code: string; expiresAt: number } | undefined;
  /** The scopes of the latest pairing code, which `completePairing` grants. */
  private offered: DeviceScope[] = ["read", "operate"];
  /** The administrator token these routes accept (a daemon token is 64 hex characters). */
  readonly token = "ace0".repeat(16);
  constructor(clock: () => number) {
    this.clock = clock;
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
  private pair(scopes: DeviceScope[]) {
    this.offered = scopes;
    const code = this.code();
    this.pending = { code, expiresAt: this.clock() + pairingLifetimeMs };
    const fragment = new URLSearchParams({
      fingerprint: "5f1c9a7e",
      code,
      scopes: scopes.join(","),
    });
    return {
      url: `https://studio-mac.tailnet.ts.net:7417/pair#${fragment.toString()}`,
      expiresAt: this.clock() + pairingLifetimeMs,
    };
  }
  /** A device scans the latest code (dev and tests): it appears in `GET /v1/devices`. */
  completePairing(name: string): Device {
    this.pending = undefined;
    const at = this.clock();
    const device = Device.parse({
      id: `device-${this.pairings}-${this.devices.length + 1}`,
      name,
      scopes: this.offered,
      createdAt: at,
      lastSeenAt: at,
      revokedAt: null,
    });
    this.devices = [...this.devices, device];
    return device;
  }
  private revoke(id: string): boolean {
    const at = this.clock();
    if (!this.list().some((device) => device.id === id)) return false;
    this.devices = this.devices.map((device) =>
      device.id === id ? Device.parse({ ...device, revokedAt: at }) : device,
    );
    return true;
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
      if (
        !this.pending ||
        parsed.data.code !== this.pending.code ||
        this.pending.expiresAt <= this.clock()
      )
        return reply(401, { error: "Expired pairing" });
      this.pending = undefined;
      return reply(200, { device: this.completePairing(parsed.data.name), token: "b".repeat(64) });
    }
    if (headers.get("authorization") !== `Bearer ${this.token}`)
      return reply(401, { error: "Administrator token required" });
    if (path === "/v1/status")
      return reply(200, {
        remoteAccess: {
          enabled: true,
          transport: "tailscale",
          listenOverride: null,
          relayOverride: false,
        },
      });
    if (path === "/v1/devices" && method === "GET") return reply(200, this.list());
    if (path === "/v1/pairings" && method === "POST") {
      const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const request = PairingRequest.safeParse(body);
      if (!request.success) return reply(400, { error: "Invalid scopes" });
      return reply(200, this.pair([...new Set(request.data.scopes)]));
    }
    if (path.startsWith("/v1/devices/") && method === "DELETE")
      return this.revoke(decodeURIComponent(path.slice("/v1/devices/".length)))
        ? reply(200, { revoked: true })
        : reply(404, { error: "Active device not found" });
    return reply(404, { error: "Unknown endpoint" });
  };
}
