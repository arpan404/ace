import { TicketPool, defaultTicketLimits, type TicketLimits } from "./ticket-pool.ts";
import { DeviceId } from "@ace/protocol";
import { allows, hash, type Device, type Devices, type Scope } from "./devices.ts";
import { validToken } from "./local-files.ts";

export class AccessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export class RemoteAuth {
  private codes = new Map<string, { expiresAt: number; scopes: Scope[] }>();
  private tickets: TicketPool;
  private attempts = new Map<string, { count: number; resetsAt: number }>();
  private devices: Devices;
  private localToken: string;
  readonly now: () => number;
  private revoked = new Set<(id: string) => void>();
  private readonly secret: () => string;
  constructor(
    devices: Devices,
    localToken: string,
    runtime: { now: () => number; secret: () => string },
    limits: TicketLimits = defaultTicketLimits,
  ) {
    this.devices = devices;
    this.localToken = localToken;
    this.now = runtime.now;
    this.secret = runtime.secret;
    this.tickets = new TicketPool(limits);
  }
  local(token: string): boolean {
    return validToken(token, this.localToken);
  }
  localBearer(token: string): Device | undefined {
    if (this.local(token))
      return {
        id: DeviceId.parse("local"),
        name: "Host",
        scopes: ["admin"],
        createdAt: 0,
        lastSeenAt: this.now(),
        revokedAt: null,
      };
    return this.deviceBearer(token);
  }
  deviceBearer(token: string): Device | undefined {
    return this.devices.authenticate(token, this.now());
  }
  pairing(granted: Scope[]): { code: string; expiresAt: number } {
    if (granted.includes("desktop"))
      throw new AccessError(403, "Desktop credentials are local only");
    this.prune(this.codes);
    if (this.codes.size >= 100) throw new AccessError(429, "Too many pending pairings");
    const code = this.secret();
    const expiresAt = this.now() + 300_000;
    this.codes.set(hash(code), { expiresAt, scopes: granted });
    return { code, expiresAt };
  }
  pairingAttempt(address: string): void {
    this.limit(address);
    this.limit("*");
  }
  redeem(code: string, name: string): { device: Device; token: string } {
    const key = hash(code);
    const pairing = this.codes.get(key);
    this.codes.delete(key);
    if (!pairing || pairing.expiresAt <= this.now())
      throw new AccessError(401, "Invalid or expired pairing code");
    return this.devices.create(name, pairing.scopes, this.now());
  }
  ticket(device: Device): { ticket: string; expiresAt: number } {
    if (device.scopes.includes("desktop"))
      throw new AccessError(403, "Desktop credentials are local only");
    const ticket = this.secret();
    const allocation = this.tickets.issue(hash(ticket), device.id, this.now());
    if ("error" in allocation) throw new AccessError(429, allocation.error);
    const { expiresAt } = allocation;
    return { ticket, expiresAt };
  }
  consume(ticket: string): Device | undefined {
    const deviceId = this.tickets.consume(hash(ticket), this.now());
    if (!deviceId) return undefined;
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt !== null || device.scopes.includes("desktop")) return undefined;
    this.devices.touch(device.id, this.now());
    return device;
  }
  list(): Device[] {
    return this.devices.list();
  }
  revoke(id: string): boolean {
    if (!this.devices.revoke(id, this.now())) return false;
    this.tickets.revoke(id);
    for (const listener of this.revoked) listener(id);
    return true;
  }
  onRevoke(listener: (id: string) => void): () => void {
    this.revoked.add(listener);
    return () => {
      this.revoked.delete(listener);
    };
  }
  requireAdmin(device: Device | undefined): void {
    if (!device || !allows(device, "admin")) throw new AccessError(403, "Admin scope required");
  }
  private prune<T extends { expiresAt: number }>(entries: Map<string, T>): void {
    for (const [key, entry] of entries) if (entry.expiresAt <= this.now()) entries.delete(key);
  }
  private limit(address: string): void {
    const now = this.now();
    for (const [key, entry] of this.attempts) if (entry.resetsAt <= now) this.attempts.delete(key);
    const entry = this.attempts.get(address) ?? { count: 0, resetsAt: now + 60_000 };
    if (this.attempts.size >= 10_000 || ++entry.count > (address === "*" ? 100 : 5))
      throw new AccessError(429, "Pairing rate limit exceeded");
    this.attempts.set(address, entry);
  }
}
