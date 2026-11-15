/*
 * What the daemon lets an NK first message cost before its client has confirmed (ADR 0155,
 * step 2, "Replays and work before confirmation"). Pure: the clock and the timer are injected.
 *
 * In order, for every NK first message:
 * 1. `arrive()`: the daemon-wide rate, before any decryption.
 * 2. `claim(device)`: the claimed device's rate, after decryption and before the credential.
 * 3. `suppress(e)`: an identical first message (same ephemeral key) within 5 minutes is refused.
 * 4. `admit(device)`: once the credential holds, the unconfirmed-session and attempt limits.
 * The admitted session then holds memory, replayed events and output under its own and the
 * daemon-wide budgets until it confirms (`confirm()`) or is closed; its deadline closes it.
 */

export const NK_LIMITS = {
  daemonRate: { perSecond: 20, burst: 40 },
  deviceRate: { perSecond: 2, burst: 4 },
  /** Claimed devices tracked for their rate; past it, a new id waits for one to go idle. */
  trackedDevices: 4096,
  suppressMs: 5 * 60_000,
  suppressEntries: 4096,
  sessionsPerDevice: 2,
  sessions: 32,
  attemptsPerDevicePerMinute: 6,
  sessionBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  sessionEvents: 2_000,
  sessionOutput: 256 * 1024,
  confirmMs: 5_000,
};
export type NkLimits = typeof NK_LIMITS;

export type NkClock = {
  now(): number;
  schedule(ms: number, run: () => void): () => void;
};

class Bucket {
  #tokens: number;
  #at: number;
  readonly #rate: { perSecond: number; burst: number };
  constructor(rate: { perSecond: number; burst: number }, now: number) {
    this.#rate = rate;
    this.#tokens = rate.burst;
    this.#at = now;
  }
  #refill(now: number): void {
    const elapsed = Math.max(0, now - this.#at);
    this.#tokens = Math.min(
      this.#rate.burst,
      this.#tokens + (elapsed * this.#rate.perSecond) / 1000,
    );
    this.#at = now;
  }
  take(now: number): boolean {
    this.#refill(now);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
  idle(now: number): boolean {
    this.#refill(now);
    return this.#tokens >= this.#rate.burst;
  }
}

/** One unconfirmed session's hold on the daemon. */
export interface NkSession {
  readonly device: string;
  readonly confirmed: boolean;
  readonly closed: boolean;
  /** Reserves projection and snapshot bytes; false when that would go over, nothing reserved. */
  reserveBytes(bytes: number): boolean;
  /** Reserves replayed events; false when that would go over, nothing reserved. */
  reserveEvents(count: number): boolean;
  /** What is left of the session's read, event and output budgets; unbounded once confirmed. */
  remaining(): { bytes: number; events: number; output: number };
  /** Counts output queued or sent; false once this would go past the session's output budget. */
  output(bytes: number): boolean;
  /** The client confirmed: its limits lift and its reservations are given back. */
  confirm(): void;
  /** Ends the session and gives back everything it held. Idempotent. */
  close(): void;
}

export class NkAdmission {
  readonly #limits: NkLimits;
  readonly #clock: NkClock;
  readonly #daemon: Bucket;
  readonly #devices = new Map<string, Bucket>();
  /** Ephemeral key (hex) to when it may be seen again; oldest first, as all live the same time. */
  readonly #seen = new Map<string, number>();
  readonly #attempts = new Map<string, number[]>();
  readonly #open = new Set<Session>();
  #bytes = 0;

  constructor(clock: NkClock, limits: NkLimits = NK_LIMITS) {
    this.#clock = clock;
    this.#limits = limits;
    this.#daemon = new Bucket(limits.daemonRate, clock.now());
  }

  /** Step 1: may this first message be decrypted at all? */
  arrive(): boolean {
    return this.#daemon.take(this.#clock.now());
  }

  /** Step 2: the claimed device's own rate. */
  claim(device: string): boolean {
    const now = this.#clock.now();
    let bucket = this.#devices.get(device);
    if (!bucket) {
      if (this.#devices.size >= this.#limits.trackedDevices)
        for (const [id, held] of this.#devices) if (held.idle(now)) this.#devices.delete(id);
      if (this.#devices.size >= this.#limits.trackedDevices) return false;
      bucket = new Bucket(this.#limits.deviceRate, now);
      this.#devices.set(device, bucket);
    }
    return bucket.take(now);
  }

  /**
   * Step 3: claims a first message's ephemeral key, synchronously, so two copies racing can't
   * both pass. `release` gives it back when the attempt is refused later; an admitted one is
   * kept for 5 minutes. A full set refuses rather than forgetting early.
   */
  suppress(ephemeral: Uint8Array): { release(): void } | "seen" | "full" {
    const now = this.#clock.now();
    for (const [key, until] of this.#seen) {
      if (until > now) break;
      this.#seen.delete(key);
    }
    const key = Buffer.from(ephemeral).toString("hex");
    if (this.#seen.has(key)) return "seen";
    if (this.#seen.size >= this.#limits.suppressEntries) return "full";
    this.#seen.set(key, now + this.#limits.suppressMs);
    return { release: () => this.#seen.delete(key) };
  }

  /**
   * Step 4, once the credential holds: a session for `device`, or undefined when the device or
   * the daemon has no room. `expire` runs if the client doesn't confirm in time; the session is
   * closed by then.
   */
  admit(device: string, expire: () => void): NkSession | undefined {
    const now = this.#clock.now();
    const recent = (this.#attempts.get(device) ?? []).filter((at) => at > now - 60_000);
    let unconfirmed = 0;
    let mine = 0;
    for (const session of this.#open) {
      unconfirmed++;
      if (session.device === device) mine++;
    }
    if (
      recent.length >= this.#limits.attemptsPerDevicePerMinute ||
      mine >= this.#limits.sessionsPerDevice ||
      unconfirmed >= this.#limits.sessions
    ) {
      this.#setAttempts(device, recent);
      return undefined;
    }
    recent.push(now);
    this.#setAttempts(device, recent);
    const session: Session = new Session(this, device, this.#limits);
    this.#open.add(session);
    session.cancel = this.#clock.schedule(this.#limits.confirmMs, () => {
      if (session.confirmed || session.closed) return;
      session.close();
      expire();
    });
    return session;
  }

  /** What unconfirmed sessions hold now, for tests and the daemon's own checks. */
  held(): { sessions: number; bytes: number; suppressed: number } {
    return { sessions: this.#open.size, bytes: this.#bytes, suppressed: this.#seen.size };
  }

  #setAttempts(device: string, recent: number[]): void {
    if (recent.length) this.#attempts.set(device, recent);
    else this.#attempts.delete(device);
  }

  /** @internal */
  free(): number {
    return this.#limits.totalBytes - this.#bytes;
  }
  /** @internal */
  take(bytes: number): boolean {
    if (this.#bytes + bytes > this.#limits.totalBytes) return false;
    this.#bytes += bytes;
    return true;
  }
  /** @internal */
  give(session: Session, bytes: number): void {
    this.#bytes -= bytes;
    this.#open.delete(session);
  }
}

class Session implements NkSession {
  readonly device: string;
  confirmed = false;
  closed = false;
  cancel: () => void = () => {};
  readonly #owner: NkAdmission;
  readonly #limits: NkLimits;
  #bytes = 0;
  #events = 0;
  #output = 0;
  constructor(owner: NkAdmission, device: string, limits: NkLimits) {
    this.#owner = owner;
    this.device = device;
    this.#limits = limits;
  }
  remaining(): { bytes: number; events: number; output: number } {
    if (this.confirmed) return { bytes: Infinity, events: Infinity, output: Infinity };
    if (this.closed) return { bytes: 0, events: 0, output: 0 };
    return {
      bytes: Math.min(this.#limits.sessionBytes - this.#bytes, this.#owner.free()),
      events: this.#limits.sessionEvents - this.#events,
      output: this.#limits.sessionOutput - this.#output,
    };
  }
  reserveBytes(bytes: number): boolean {
    if (this.confirmed) return true;
    if (this.closed || this.#bytes + bytes > this.#limits.sessionBytes) return false;
    if (!this.#owner.take(bytes)) return false;
    this.#bytes += bytes;
    return true;
  }
  reserveEvents(count: number): boolean {
    if (this.confirmed) return true;
    if (this.closed || this.#events + count > this.#limits.sessionEvents) return false;
    this.#events += count;
    return true;
  }
  output(bytes: number): boolean {
    if (this.confirmed) return true;
    if (this.closed || this.#output + bytes > this.#limits.sessionOutput) return false;
    this.#output += bytes;
    return true;
  }
  confirm(): void {
    if (this.closed || this.confirmed) return;
    this.confirmed = true;
    this.#release();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.confirmed) this.#release();
  }
  #release(): void {
    this.cancel();
    this.#owner.give(this, this.#bytes);
    this.#bytes = 0;
  }
}
