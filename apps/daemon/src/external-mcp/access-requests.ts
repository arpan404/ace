/*
 * Sign-in and step-up requests from outside clients waiting for the person (ADR 0117). The
 * OAuth `/authorize` page opens one and waits; admin devices see it (`outside.state`) and the
 * person approves with the scopes, projects and expiry they chose, or denies. The page decides
 * nothing itself. Approval in ace is the only way a request becomes a grant.
 */
import type { OutsideAccessDecision, OutsideAccessRequest, OutsideScope } from "@ace/protocol";
import type { RandomBytes } from "./tokens.ts";

export interface AccessRequestInput {
  clientName: string;
  /** Null: unverified (DCR). */
  domain: string | null;
  scopes: readonly OutsideScope[];
  /** Where the code goes if approved (`redirectTarget`), so the person can judge it. */
  redirectHost: string;
  redirectKind: "web" | "this-device";
}
/**
 * How a request ended: the person's choice and the admin device that made it (the grant's
 * `approvedBy`), or nobody answered in time.
 */
export type AccessOutcome = (OutsideAccessDecision & { by: string }) | { decision: "expired" };

export const accessRequestTtlMs = 10 * 60 * 1000;
// No 0/O or 1/I/L: the person reads the code off one screen and finds it on another.
const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

interface Pending {
  request: OutsideAccessRequest;
  settle(outcome: AccessOutcome): void;
  cancelTimer(): void;
}

export class AccessRequests {
  private pending = new Map<string, Pending>();
  private listeners = new Set<(requests: readonly OutsideAccessRequest[]) => void>();
  private options: {
    now: () => number;
    id: () => string;
    random: RandomBytes;
    after: (ms: number, run: () => void) => () => void;
    ttlMs?: number;
  };
  constructor(options: AccessRequests["options"]) {
    this.options = options;
  }
  /**
   * Shows a request to admin devices. `outcome` settles once: when the person decides, when it
   * expires, or when it is cancelled (`expired`).
   */
  open(input: AccessRequestInput): {
    request: OutsideAccessRequest;
    outcome: Promise<AccessOutcome>;
  } {
    if (this.pending.size >= 64) throw new Error("Too many sign-in requests are waiting");
    const ttl = this.options.ttlMs ?? accessRequestTtlMs;
    const request: OutsideAccessRequest = {
      requestId: this.options.id(),
      clientName: input.clientName,
      domain: input.domain,
      scopes: [...input.scopes],
      matchCode: this.matchCode(),
      expiresAt: this.options.now() + ttl,
      redirectHost: input.redirectHost,
      redirectKind: input.redirectKind,
    };
    const settled = Promise.withResolvers<AccessOutcome>();
    const entry: Pending = {
      request,
      settle: (outcome) => {
        if (this.pending.get(request.requestId) !== entry) return;
        this.pending.delete(request.requestId);
        entry.cancelTimer();
        settled.resolve(outcome);
        this.changed();
      },
      cancelTimer: () => {},
    };
    this.pending.set(request.requestId, entry);
    entry.cancelTimer = this.options.after(ttl, () => entry.settle({ decision: "expired" }));
    this.changed();
    return { request, outcome: settled.promise };
  }
  /** The person's choice for a waiting request; false when it is gone or expired. */
  decide(requestId: string, choice: OutsideAccessDecision, by: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.request.expiresAt <= this.options.now()) return false;
    entry.settle({ ...choice, by });
    return true;
  }
  /** The client went away before anyone answered. */
  cancel(requestId: string): void {
    this.pending.get(requestId)?.settle({ decision: "expired" });
  }
  current(): OutsideAccessRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }
  subscribe(listener: (requests: readonly OutsideAccessRequest[]) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  close(): void {
    for (const entry of this.pending.values()) entry.settle({ decision: "expired" });
  }
  private matchCode(): string {
    const bytes = this.options.random(6);
    return [...bytes].map((byte) => codeAlphabet[byte % codeAlphabet.length]).join("");
  }
  private changed(): void {
    const requests = this.current();
    for (const listener of this.listeners) listener(requests);
  }
}
