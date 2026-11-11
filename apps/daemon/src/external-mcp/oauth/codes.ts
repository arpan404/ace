/*
 * Authorization codes (OAuth 2.1 §4.1): random, kept only as hashes in memory, good once for
 * 60 seconds, and bound to the grant, client, redirect URI, PKCE challenge and resource they were
 * issued for. A daemon restart drops them; the client signs in again.
 */
import { createHash } from "node:crypto";
import type { RandomBytes } from "../tokens.ts";

export const codeTtlMs = 60_000;
/** How long a traded code is remembered, to catch it being presented again. */
export const spentCodeKeptMs = 10 * 60_000;
const maxCodes = 256;
const verifierShape = /^[A-Za-z0-9._~-]{43,128}$/;
/** An S256 challenge: base64url of a SHA-256, without padding. */
export const challengeShape = /^[A-Za-z0-9_-]{43}$/;

export interface CodeBinding {
  grantId: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
}
/**
 * `reused`: the code was presented before, so someone else holds it; the grant it was issued
 * for should lose its tokens (OAuth 2.1 §4.1.3).
 */
export type Redemption = { grantId: string } | { refused: string; reused?: string };

function digest(text: string, encoding: "hex" | "base64url"): string {
  return createHash("sha256").update(text).digest(encoding);
}
/** Whether `verifier` answers an S256 `challenge` (RFC 7636 §4.6). */
export function pkceMatches(verifier: string, challenge: string): boolean {
  return verifierShape.test(verifier) && digest(verifier, "base64url") === challenge;
}

export class AuthorizationCodes {
  private codes = new Map<string, CodeBinding & { expiresAt: number }>();
  private spent = new Map<string, { grantId: string; until: number }>();
  private now: () => number;
  private random: RandomBytes;
  constructor(options: { now: () => number; random: RandomBytes }) {
    this.now = options.now;
    this.random = options.random;
  }
  issue(binding: CodeBinding): string {
    const now = this.now();
    for (const [key, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(key);
    // Oldest first: a flood of sign-ins drops the oldest waiting code, never the newest.
    while (this.codes.size >= maxCodes) {
      const oldest = this.codes.keys().next().value;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
    const code = this.random(32).toString("base64url");
    this.codes.set(digest(code, "hex"), { ...binding, expiresAt: now + codeTtlMs });
    return code;
  }
  /**
   * Trades a code once. Any attempt uses it up, so a code that was presented wrongly can't be
   * tried again; what was presented must match everything it was bound to.
   */
  redeem(
    code: string,
    presented: { clientId: string; redirectUri: string; verifier: string; resource: string },
  ): Redemption {
    const key = digest(code, "hex");
    const now = this.now();
    const entry = this.codes.get(key);
    this.codes.delete(key);
    const before = this.spent.get(key);
    if (!entry && before && before.until > now)
      return { refused: "The code was already used.", reused: before.grantId };
    if (!entry || entry.expiresAt <= now) return { refused: "The code is unknown or used." };
    this.remember(key, entry.grantId, now);
    if (entry.clientId !== presented.clientId)
      return { refused: "The code was issued to another client." };
    if (entry.redirectUri !== presented.redirectUri)
      return { refused: "redirect_uri differs from the authorization request." };
    if (entry.resource !== presented.resource)
      return { refused: "The code was issued for another resource." };
    if (!pkceMatches(presented.verifier, entry.challenge))
      return { refused: "code_verifier doesn't match the code challenge." };
    return { grantId: entry.grantId };
  }
  private remember(key: string, grantId: string, now: number): void {
    for (const [spentKey, spent] of this.spent)
      if (spent.until <= now) this.spent.delete(spentKey);
    while (this.spent.size >= maxCodes) {
      const oldest = this.spent.keys().next().value;
      if (oldest === undefined) break;
      this.spent.delete(oldest);
    }
    this.spent.set(key, { grantId, until: now + spentCodeKeptMs });
  }
}
