import type { OutsideGrant } from "@ace/protocol";
import type { GrantStore } from "../external-mcp/grants.ts";
import type { GrantTokens } from "../external-mcp/tokens.ts";

/** Shown for Spade's grant in the list of outside grants. */
const spadeClient = { clientKind: "spade", clientId: "spade", name: "Spade" } as const;

/**
 * Spade's durable grant (ADR 0123): one row among ADR 0122's outside grants, so it is stored,
 * listed and revoked the same way and survives daemon restarts. What it may do is not its scopes
 * but its host thread's lease, which `SpadeGrantAuthenticator` gives it on the daemon's own MCP
 * endpoint. Its token is a pasted-style bearer: only its hash is kept, so handing it to Spade
 * again means issuing a new one.
 */
export class SpadeGrants {
  private readonly grants: GrantStore;
  private readonly tokens: GrantTokens;
  constructor(grants: GrantStore, tokens: GrantTokens) {
    this.grants = grants;
    this.tokens = tokens;
  }
  /** The live Spade grant, if there is one. */
  current(): OutsideGrant | undefined {
    return this.grants.liveGrants().find((grant) => grant.clientKind === "spade");
  }
  /** The live grant, made if there is none. */
  ensure(): OutsideGrant {
    return (
      this.current() ??
      this.grants.create({
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
      })
    );
  }
  /**
   * A new token for the grant; every earlier one stops working. The grant reads as unused until
   * Spade first calls with it, which is how a restarted daemon knows Spade may lack it.
   */
  issue(grant: OutsideGrant): string {
    this.tokens.revokeTokens(grant.id);
    this.grants.markUnused(grant.id);
    return this.tokens.issueBearer(grant);
  }
  /** The live Spade grant `bearer` belongs to; records the use. Reads SQLite every call. */
  verify(bearer: string): OutsideGrant | undefined {
    const grant = this.tokens.verify(bearer);
    if (grant?.clientKind !== "spade") return undefined;
    this.grants.touch(grant);
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
    return retired;
  }
  /**
   * Whether Spade, turned on, should have a grant it lacks: none was ever made, or the last one
   * ended because Spade was turned off. One the person revoked stays revoked until Spade is
   * turned on again.
   */
  wanted(): boolean {
    if (this.current()) return false;
    const last = this.grants.list().find((grant) => grant.clientKind === "spade");
    return !last || last.expiresAt !== null;
  }
  /** Whether a grant id is Spade's (live or not). */
  owns(grantId: string): boolean {
    return this.grants.get(grantId)?.clientKind === "spade";
  }
}
