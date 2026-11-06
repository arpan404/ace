import { TicketPool, defaultTicketLimits, type TicketLimits } from "./ticket-pool.ts";
import { DeviceId, PendingPairing, type InstallId } from "@ace/protocol";
import {
  allows,
  hash,
  type Device,
  type Devices,
  type PairedDevice,
  type Scope,
} from "./devices.ts";
import { validToken } from "./local-files.ts";
import { MemoryPairingCodes, type PairingCodeStore } from "./pairing-codes.ts";

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
const localOnly = (device: Pick<Device, "scopes">) =>
  device.scopes.includes("desktop") || device.scopes.includes("user-browser");

export class RemoteAuth {
  private codes: PairingCodeStore;
  private tickets: TicketPool;
  private ticketLimits: TicketLimits;
  private attempts = new Map<string, { count: number; resetsAt: number }>();
  private devices: Devices;
  private localToken: string;
  readonly now: () => number;
  private revoked = new Set<(id: string) => void>();
  private replaced = new Set<(id: string) => void>();
  private readonly secret: () => string;
  private readonly id: () => string;
  constructor(
    devices: Devices,
    localToken: string,
    runtime: { now: () => number; secret: () => string; id?: () => string },
    limits: TicketLimits = defaultTicketLimits,
    codes: PairingCodeStore = new MemoryPairingCodes(),
  ) {
    this.codes = codes;
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
  deviceBearer(token: string): PairedDevice | undefined {
    return this.devices.authenticate(token, this.now());
  }
  /** A single-use pairing code. Callers check the creator may grant `granted` first. */
  pairing(
    granted: Scope[],
    terms: PairingTerms = {},
  ): { id: string; code: string; expiresAt: number } {
    if (granted.includes("desktop") || granted.includes("user-browser"))
      throw new AccessError(403, "Desktop credentials are local only");
    if (this.codes.pending(this.now()).length >= 100)
      throw new AccessError(429, "Too many pending pairings");
    const code = this.secret();
    const id = this.id();
    const expiresAt = this.now() + (terms.ttlMs ?? 300_000);
    this.codes.put(hash(code), {
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
    return this.codes
      .pending(this.now())
      .map(({ id, label, scopes, expiresAt, deviceTtlMs }) =>
        PendingPairing.parse({ id, label, scopes, expiresAt, deviceTtlMs }),
      );
  }
  /** False when no pending link has that id. */
  cancelPairing(id: string): boolean {
    return this.codes.remove(id);
  }
  pairingAttempt(address: string): void {
    this.limit(address);
    this.limit("*");
  }
  /** Redeems a pairing; the same app install (`installId`, ADR 0115) keeps its one record. */
  redeem(code: string, name: string, installId?: InstallId): { device: Device; token: string } {
    const pairing = this.codes.take(hash(code));
    if (!pairing || pairing.expiresAt <= this.now())
      throw new AccessError(401, "Invalid or expired pairing code");
    const at = this.now();
    const held = installId === undefined ? undefined : this.devices.heldBy(installId, at);
    const { device, token } = this.devices.create(
      pairing.label ?? name,
      pairing.scopes,
      at,
      pairing.deviceTtlMs ? at + pairing.deviceTtlMs : null,
      installId,
    );
    // The install's record got a new credential and scopes: what the old one opened ends, so
    // no ticket, socket or lease carries the old authority or picks up the new.
    if (held !== undefined) {
      this.tickets.revoke(held);
      for (const listener of this.replaced) listener(held);
    }
    return { device, token };
  }
  /**
   * An ace account device was admitted: its account device id is its install id (ADR 0115), so
   * the same install's paired record is the device it is, seen now.
   */
  accountDeviceSeen(deviceId: string): void {
    this.devices.seen(deviceId, this.now());
  }
  /** A paired device's hello named its app install: its records fold into one (ADR 0115). */
  recognize(device: Pick<Device, "id">, installId: InstallId | undefined): void {
    if (installId !== undefined) this.devices.recognize(device.id, installId, this.now());
  }
  ticket(device: PairedDevice): { ticket: string; expiresAt: number } {
    if (device.scopes.includes("desktop") || device.scopes.includes("user-browser"))
      throw new AccessError(403, "Desktop credentials are local only");
    const ticket = this.secret();
    const allocation = this.tickets.issue(hash(ticket), device.id, device.generation, this.now());
    if ("error" in allocation) throw new AccessError(429, allocation.error);
    const { expiresAt } = allocation;
    return { ticket, expiresAt };
  }
  consume(ticket: string): PairedDevice | undefined {
    const issued = this.tickets.consume(hash(ticket), this.now());
    if (!issued) return undefined;
    // A ticket asked for with a credential since replaced opens nothing.
    const device = this.devices.current(issued.deviceId, issued.generation, this.now());
    if (!device || localOnly(device)) return undefined;
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
  /**
   * Revokes `id` and every record folded into it (ADR 0115). Listeners hear each revoked id, so
   * the folded records' sockets, notifications and relay channels close too.
   */
  revoke(id: string): boolean {
    const revoked = this.devices.revokeInstall(id, this.now());
    for (const each of revoked) {
      this.tickets.revoke(each);
      for (const listener of this.revoked) listener(each);
    }
    return revoked.length > 0;
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
  /**
   * A paired device's credential was replaced by pairing the same install again. Sessions it
   * opened with the old credential no longer carry authority; listeners close them. Account
   * sessions of the install are not the pairing's and stay open.
   */
  onCredentialReplaced(listener: (id: string) => void): () => void {
    this.replaced.add(listener);
    return () => {
      this.replaced.delete(listener);
    };
  }
  requireAdmin(device: Device | undefined): void {
    if (!device || !allows(device, "admin")) throw new AccessError(403, "Admin scope required");
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
