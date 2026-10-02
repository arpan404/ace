import { DeviceId } from "@ace/protocol";
import { allows, hash, secret, type Device, type Devices, type Scope } from "./devices.ts";
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
  private tickets = new Map<string, { expiresAt: number; deviceId: string }>();
  private attempts = new Map<string, { count: number; resetsAt: number }>();
  private devices: Devices;
  private localToken: string;
  readonly now: () => number;
  private revoked = new Set<(id: string) => void>();
  constructor(devices: Devices, localToken: string, now = Date.now) {
    this.devices = devices;
    this.localToken = localToken;
    this.now = now;
  }
  local(token: string, local: boolean): boolean {
    return local && validToken(token, this.localToken);
  }
  bearer(token: string, local: boolean): Device | undefined {
    if (this.local(token, local))
      return {
        id: DeviceId.parse("local"),
        name: "Host",
        scopes: ["admin"],
        createdAt: 0,
        lastSeenAt: this.now(),
        revokedAt: null,
      };
    return this.devices.authenticate(token, this.now());
  }
  pairing(granted: Scope[]): { code: string; expiresAt: number } {
    this.prune(this.codes);
    if (this.codes.size >= 100) throw new AccessError(429, "Too many pending pairings");
    const code = secret();
    const expiresAt = this.now() + 300_000;
    this.codes.set(hash(code), { expiresAt, scopes: granted });
    return { code, expiresAt };
  }
  redeem(code: string, name: string, address: string): { device: Device; token: string } {
    this.limit(address);
    this.limit("*");
    const key = hash(code);
    const pairing = this.codes.get(key);
    this.codes.delete(key);
    if (!pairing || pairing.expiresAt <= this.now())
      throw new AccessError(401, "Invalid or expired pairing code");
    return this.devices.create(name, pairing.scopes, this.now());
  }
  ticket(device: Device): { ticket: string; expiresAt: number } {
    this.prune(this.tickets);
    if (this.tickets.size >= 10_000) throw new AccessError(429, "Too many pending tickets");
    const ticket = secret();
    const expiresAt = this.now() + 60_000;
    this.tickets.set(hash(ticket), { expiresAt, deviceId: device.id });
    return { ticket, expiresAt };
  }
  consume(ticket: string): Device | undefined {
    const key = hash(ticket);
    const entry = this.tickets.get(key);
    this.tickets.delete(key);
    if (!entry || entry.expiresAt <= this.now()) return undefined;
    const device = this.devices.get(entry.deviceId);
    if (!device || device.revokedAt !== null) return undefined;
    this.devices.touch(device.id, this.now());
    return device;
  }
  list(): Device[] {
    return this.devices.list();
  }
  revoke(id: string): boolean {
    if (!this.devices.revoke(id, this.now())) return false;
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
