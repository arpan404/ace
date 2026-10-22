import { TicketPool, defaultTicketLimits, type TicketLimits } from "./ticket-pool.ts";
import { DeviceId, PendingPairing } from "@ace/protocol";
import { activeDevice, allows, hash, type Device, type Devices, type Scope } from "./devices.ts";
import { validToken } from "./local-files.ts";

export class AccessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
/** What a pairing link grants beyond its scopes. */
export interface PairingTerms {
  /** Names the redeemed device instead of the name it sends. */
  label?: string | undefined;
  /** How long the link can be redeemed; 5 minutes when omitted. */
  ttlMs?: number | undefined;
  /** How long the paired device keeps access; until revoked when omitted or null. */
  deviceTtlMs?: number | null | undefined;
}
interface Pending {
  id: string;
  expiresAt: number;
  scopes: Scope[];
  label?: string | undefined;
  deviceTtlMs?: number | undefined;
}
const localOnly = (device: Pick<Device, "scopes">) =>
  device.scopes.includes("desktop") || device.scopes.includes("user-browser");

export class RemoteAuth {
  private codes = new Map<string, Pending>();
  private tickets: TicketPool;
  private ticketLimits: TicketLimits;
  private attempts = new Map<string, { count: number; resetsAt: number }>();
  private devices: Devices;
  private localToken: string;
  readonly now: () => number;
  private revoked = new Set<(id: string) => void>();
  private readonly secret: () => string;
  private readonly id: () => string;
  constructor(
    devices: Devices,
    localToken: string,
    runtime: { now: () => number; secret: () => string; id?: () => string },
    limits: TicketLimits = defaultTicketLimits,
  ) {
    this.devices = devices;
    this.localToken = localToken;
    this.now = runtime.now;
    this.secret = runtime.secret;
    let issued = 0;
    this.id = runtime.id ?? (() => `pairing-${++issued}`);
    this.ticketLimits = limits;
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
        scopes: ["admin", "projects"],
        createdAt: 0,
        lastSeenAt: this.now(),
        revokedAt: null,
      };
    return this.deviceBearer(token);
  }
  deviceBearer(token: string): Device | undefined {
    return this.devices.authenticate(token, this.now());
  }
  /** A single-use pairing code. Callers check the creator may grant `granted` first. */
  pairing(
    granted: Scope[],
    terms: PairingTerms = {},
  ): { id: string; code: string; expiresAt: number } {
    if (granted.includes("desktop") || granted.includes("user-browser"))
      throw new AccessError(403, "Desktop credentials are local only");
    this.prune(this.codes);
    if (this.codes.size >= 100) throw new AccessError(429, "Too many pending pairings");
    const code = this.secret();
    const id = this.id();
    const expiresAt = this.now() + (terms.ttlMs ?? 300_000);
    this.codes.set(hash(code), {
      id,
      expiresAt,
      scopes: granted,
      ...(terms.label ? { label: terms.label } : {}),
      ...(terms.deviceTtlMs ? { deviceTtlMs: terms.deviceTtlMs } : {}),
    });
    return { id, code, expiresAt };
  }
  /** Links not yet redeemed or expired, oldest first. Never their codes. */
  pendingPairings(): PendingPairing[] {
    this.prune(this.codes);
    return [...this.codes.values()]
      .toSorted((a, b) => a.expiresAt - b.expiresAt)
      .map(({ id, label, scopes, expiresAt, deviceTtlMs }) =>
        PendingPairing.parse({ id, label, scopes, expiresAt, deviceTtlMs }),
      );
  }
  /** False when no pending link has that id. */
  cancelPairing(id: string): boolean {
    for (const [key, pending] of this.codes)
      if (pending.id === id) {
        this.codes.delete(key);
        return true;
      }
    return false;
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
    const at = this.now();
    return this.devices.create(
      pairing.label ?? name,
      pairing.scopes,
      at,
      pairing.deviceTtlMs ? at + pairing.deviceTtlMs : null,
    );
  }
  ticket(device: Device): { ticket: string; expiresAt: number } {
    if (device.scopes.includes("desktop") || device.scopes.includes("user-browser"))
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
    if (!activeDevice(device, this.now()) || localOnly(device)) return undefined;
    this.devices.touch(device.id, this.now());
    return device;
  }
  clearPending(): void {
    this.codes.clear();
    this.tickets = new TicketPool(this.ticketLimits);
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
  /**
   * Revoke every paired device but `keep` and the daemon's local credentials (the desktop app,
   * "Use my Chrome"). Returns how many were revoked.
   */
  revokeOthers(keep: string | undefined): number {
    let count = 0;
    for (const device of this.devices.list())
      if (
        device.id !== keep &&
        device.revokedAt === null &&
        !localOnly(device) &&
        this.revoke(device.id)
      )
        count++;
    return count;
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
