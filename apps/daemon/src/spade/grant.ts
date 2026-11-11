import type { OutsideGrant, SpadeStatus } from "@ace/protocol";
import type { GrantStore } from "../external-mcp/grants.ts";
import type { GrantTokens } from "../external-mcp/tokens.ts";

/** Spade's grant row; the outside clients' list never shows it. */
const spadeClient = { clientKind: "spade", clientId: "spade", name: "Spade" } as const;

/**
 * Spade's durable grant (ADR 0123): stored in ADR 0122's grant tables, so it survives daemon
 * restarts and every request reads it again, but kept out of the outside clients' list and
 * revoke: it is shown in `spade.status` and revoked with `spade.grant.revoke`. What it may do is not its scopes
 * but its host thread's lease, which `SpadeGrantAuthenticator` gives it on the daemon's own MCP
 * endpoint. Its token is a pasted-style bearer: only its hash is kept, so handing it to Spade
 * again means issuing a new one.
 */
export class SpadeGrants {
  private readonly grants: GrantStore;
  private readonly tokens: GrantTokens;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  constructor(grants: GrantStore, tokens: GrantTokens, now: () => number) {
    this.grants = grants;
    this.tokens = tokens;
    this.now = now;
  }
  /** Called whenever what `summary` reports may have changed. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** For `spade.status`: whether a grant works now, and when Spade last used it. */
  summary(): SpadeStatus["grant"] {
    const live = this.current();
    const grant = live ?? this.grants.latest("spade");
    if (!grant) return undefined;
    return { state: live ? "present" : "revoked", lastUsedAt: grant.lastUsedAt };
  }
  /** The live Spade grant, if there is one. */
  current(): OutsideGrant | undefined {
    return this.grants.liveGrants().find((grant) => grant.clientKind === "spade");
  }
  /** The live grant, made if there is none. */
  ensure(): OutsideGrant {
    const live = this.current();
    if (live) return live;
    const made = this.grants.create({
      ...spadeClient,
      domain: null,
      // Descriptive only: the lease decides, and Settings can't edit this grant.
      scopes: [
        "threads:read",
        "threads:start",
        "threads:message",
        "threads:stop",
        "browser",
        "computer",
      ],
      projects: "all",
      expiresAt: null,
      approvedBy: "local",
    });
    this.changed();
    return made;
  }
  /**
   * A new token for the grant; every earlier one stops working. The grant reads as unused until
   * Spade first calls with it, which is how a restarted daemon knows Spade may lack it.
   */
  issue(grant: OutsideGrant): string {
    this.tokens.revokeTokens(grant.id);
    this.grants.markUnused(grant.id);
    const token = this.tokens.issueBearer(grant);
    this.changed();
    return token;
  }
  /** The live Spade grant `bearer` belongs to; records the use. Reads SQLite every call. */
  verify(bearer: string): OutsideGrant | undefined {
    const grant = this.tokens.verify(bearer);
    if (grant?.clientKind !== "spade") return undefined;
    // The store writes a use at most once a minute; status follows those writes only.
    const writes = grant.lastUsedAt === null || this.now() - grant.lastUsedAt >= 60_000;
    this.grants.touch(grant);
    if (writes) this.changed();
    return grant;
  }
  /**
   * Spade was turned off: every live Spade grant ends, recorded as expired at that moment as
   * well as revoked, which is how `wanted` tells it from the person revoking it. The ids ended.
   */
  retireAll(now: number): string[] {
    const retired: string[] = [];
    for (const grant of this.grants.liveGrants()) {
      if (grant.clientKind !== "spade") continue;
      this.grants.update(grant.id, { expiresAt: now });
      this.grants.revoke(grant.id);
      this.tokens.revokeTokens(grant.id);
      retired.push(grant.id);
    }
    if (retired.length) this.changed();
    return retired;
  }
  /**
   * The person revoked Spade's grant: it stops working and is not remade until Spade is turned
   * on again. The id revoked, or undefined when no grant was live.
   */
  revoke(): string | undefined {
    const grant = this.current();
    if (!grant) return undefined;
    this.grants.revoke(grant.id);
    this.tokens.revokeTokens(grant.id);
    this.changed();
    return grant.id;
  }
  /**
   * Whether Spade, turned on, should have a grant it lacks: none was ever made, or the last one
   * ended because Spade was turned off. One the person revoked stays revoked until Spade is
   * turned on again.
   */
  wanted(): boolean {
    if (this.current()) return false;
    const last = this.grants.latest("spade");
    return !last || last.expiresAt !== null;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
