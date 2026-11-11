import { randomBytes } from "node:crypto";
import { nodeScheduler, type Scheduler } from "@ace/mcp-server";
import type { OutsideAccessDecision, OutsideGrant } from "@ace/protocol";
import { AccessRequests } from "./access-requests.ts";
import { GrantStore, type GrantChange, type GrantSql } from "./grants.ts";
import { GrantPrincipals } from "./principals.ts";
import { OutsideScreen } from "./screen-use.ts";
import { GrantTokens, type RandomBytes } from "./tokens.ts";

export interface OutsideAccessOptions {
  /** The daemon store's statements and transactions. */
  sql: GrantSql;
  now: () => number;
  id: () => string;
  random?: RandomBytes;
  scheduler?: Scheduler;
  /** How long a sign-in request waits for the person; tests shorten it. */
  requestTtlMs?: number;
  /** A grant ended (revoked or expired): remove its token file. Never throws. */
  ended: (grantId: string) => void;
  /** Close the grant's browser session (it ended, or lost `browser`). Never throws. */
  closeBrowser: (grantId: string) => void;
  /** A note for the daemon log, e.g. who stopped a grant's screen work. Never a token. */
  note?: (text: string) => void;
  /** A grant's scopes or projects changed: clients reload their tool lists. */
  changed?: () => void;
}

/**
 * Everything the daemon keeps about outside MCP clients (ADR 0122), with no HTTP: the grants,
 * their tokens, the principal each acts as, the person's pending sign-in requests and outside
 * screen use. The MCP endpoint, the admin wire protocol and the OAuth endpoints all go through
 * this one owner, so revoking always ends the same work.
 */
export class OutsideAccess {
  readonly grants: GrantStore;
  readonly tokens: GrantTokens;
  readonly principals: GrantPrincipals;
  readonly screen: OutsideScreen;
  readonly requests: AccessRequests;
  private options: OutsideAccessOptions;
  private readonly endedListeners = new Set<(grantId: string) => void>();
  constructor(options: OutsideAccessOptions) {
    this.options = options;
    const { sql, now, id } = options;
    const random = options.random ?? randomBytes;
    const scheduler = options.scheduler ?? nodeScheduler;
    this.grants = new GrantStore(sql, now, id);
    this.screen = new OutsideScreen(scheduler.after);
    this.requests = new AccessRequests({
      now,
      id,
      random,
      after: scheduler.after,
      ...(options.requestTtlMs === undefined ? {} : { ttlMs: options.requestTtlMs }),
    });
    this.tokens = new GrantTokens({
      sql,
      grants: this.grants,
      now,
      random,
      revoked: (grantId) => this.principals.end(grantId),
    });
    this.principals = new GrantPrincipals({
      tokens: this.tokens,
      grants: this.grants,
      scheduler,
      now,
      ended: (grantId) => {
        this.screen.stop(grantId);
        options.closeBrowser(grantId);
        options.ended(grantId);
        for (const listener of this.endedListeners) listener(grantId);
      },
    });
    // Grants live before a restart expire on time without waiting for their next request.
    this.principals.watch(this.grants.liveGrants());
  }
  /**
   * Revokes a grant: its row stays, every token stops working, and its calls, listen streams,
   * tabs and screen work end now. False when it was already revoked or never existed.
   */
  revoke(grantId: string): boolean {
    const revoked = this.grants.revoke(grantId);
    if (!revoked) return false;
    this.tokens.revokeTokens(grantId);
    this.principals.end(grantId);
    return true;
  }
  /** Called with each grant that ends (revoked or expired), whoever ended it. */
  onEnded(listener: (grantId: string) => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }
  /**
   * Changes a live grant; the next request reads it. Spade's grant is not changed here: what it
   * may do is its host thread's lease (ADR 0123), so it is only made or revoked.
   */
  update(grantId: string, change: GrantChange): OutsideGrant | undefined {
    if (this.grants.get(grantId)?.clientKind === "spade") return undefined;
    const grant = this.grants.update(grantId, change);
    if (!grant) return undefined;
    this.principals.rearm(grant);
    // Narrowed scopes end the work they no longer allow.
    if (!grant.scopes.includes("computer")) this.screen.stop(grantId);
    if (!grant.scopes.includes("browser")) this.options.closeBrowser(grantId);
    this.options.changed?.();
    return grant;
  }
  /**
   * Stop on "<client> is using this Mac": ends the grant's screen work now and takes `computer`
   * out of the grant, so a client calling in a loop can't carry on. The person gives it back in
   * Settings. `by` is the device that pressed Stop. False when the grant isn't live.
   */
  stopScreen(grantId: string, by: string): boolean {
    const grant = this.grants.live(grantId);
    if (!grant || grant.clientKind === "spade") return false;
    this.screen.stop(grantId);
    if (!grant.scopes.includes("computer")) return true;
    const updated = this.update(grantId, {
      scopes: grant.scopes.filter((scope) => scope !== "computer"),
    });
    if (updated) this.options.note?.(`Screen use by ${grant.name} (${grantId}) stopped by ${by}.`);
    return updated !== undefined;
  }
  /** The person's answer to a sign-in request, from admin device `by`. */
  decide(requestId: string, choice: OutsideAccessDecision, by: string): boolean {
    return this.requests.decide(requestId, choice, by);
  }
  close(): void {
    this.requests.close();
    this.principals.close();
  }
}
