import { randomBytes } from "node:crypto";
import { nodeScheduler, type Scheduler } from "@ace/mcp-server";
import type { OutsideAccessDecision, OutsideGrant } from "@ace/protocol";
import type { Store } from "../store.ts";
import { AccessRequests } from "./access-requests.ts";
import { GrantStore, type GrantChange } from "./grants.ts";
import { GrantPrincipals } from "./principals.ts";
import { OutsideScreen } from "./screen-use.ts";
import { GrantTokens, type RandomBytes } from "./tokens.ts";

export interface OutsideAccessOptions {
  store: Store;
  now: () => number;
  id: () => string;
  random?: RandomBytes;
  scheduler?: Scheduler;
  /** A grant ended (revoked or expired): close its tabs, its token file. Never throws. */
  ended: (grantId: string) => void;
  /** A grant's scopes or projects changed: clients reload their tool lists. */
  changed?: () => void;
}

/**
 * Everything the daemon keeps about outside MCP clients (ADR 0117), with no HTTP: the grants,
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
  constructor(options: OutsideAccessOptions) {
    this.options = options;
    const { store, now, id } = options;
    const random = options.random ?? randomBytes;
    const scheduler = options.scheduler ?? nodeScheduler;
    const sql = {
      statement: (text: string) => store.statement(text),
      atomic: <T>(run: () => T) => store.atomic(run),
    };
    this.grants = new GrantStore(sql, now, id);
    this.screen = new OutsideScreen(scheduler.after);
    this.requests = new AccessRequests({ now, id, random, after: scheduler.after });
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
        options.ended(grantId);
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
  /** Changes a live grant; the next request reads it. */
  update(grantId: string, change: GrantChange): OutsideGrant | undefined {
    const grant = this.grants.update(grantId, change);
    if (!grant) return undefined;
    this.principals.rearm(grant);
    // Narrowed scopes end the work they no longer allow.
    if (!grant.scopes.includes("computer")) this.screen.stop(grantId);
    this.options.changed?.();
    return grant;
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
