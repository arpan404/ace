import type { Authenticator, Principal, Scheduler } from "@ace/mcp-server";
import { AgentId, ThreadId, type McpCapability, type OutsideGrant } from "@ace/protocol";
import type { GrantStore } from "./grants.ts";
import type { GrantTokens } from "./tokens.ts";

/**
 * Every outside grant acts as one stable caller: its tool calls, listen streams and browser tabs
 * all belong to `external:<grantId>`. What it may call is decided per request from its scopes
 * (`scopes.ts`), so the principal itself carries every group the outside endpoint registers.
 */
export function grantCaller(grantId: string) {
  return {
    sessionId: grantId,
    threadId: ThreadId.parse(`external:${grantId}`),
    agentId: AgentId.parse(`external:${grantId}`),
  };
}
/** The grant whose caller thread id this is, when it is an outside grant's. */
export function grantOfCaller(threadId: string): string | undefined {
  return threadId.startsWith("external:") ? threadId.slice("external:".length) : undefined;
}

const capabilities: readonly McpCapability[] = ["thread_control", "agents", "browser", "screen"];
// Timers longer than this fire at once in Node; a later expiry is checked again at this bound.
const longestTimerMs = 2 ** 31 - 1;

/**
 * Authenticates outside tokens against SQLite on every request and hands each live grant its
 * one principal. Ending a grant (revoke, expiry) aborts that principal, which ends its calls and
 * listen streams; `ended` hears it so the owner can close the grant's tabs and screen work.
 */
export class GrantPrincipals implements Authenticator {
  private live = new Map<
    string,
    { principal: Principal; abort(): void; cancelTimer(): void; expiresAt: number | null }
  >();
  private tokens: GrantTokens;
  private grants: GrantStore;
  private scheduler: Scheduler;
  private now: () => number;
  private ended: (grantId: string) => void;
  private closed = false;
  constructor(options: {
    tokens: GrantTokens;
    grants: GrantStore;
    scheduler: Scheduler;
    now: () => number;
    ended: (grantId: string) => void;
  }) {
    this.tokens = options.tokens;
    this.grants = options.grants;
    this.scheduler = options.scheduler;
    this.now = options.now;
    this.ended = options.ended;
  }
  authenticate(bearer: string): Principal | undefined {
    if (this.closed) return undefined;
    const grant = this.tokens.verify(bearer);
    if (!grant) return undefined;
    this.grants.touch(grant);
    return this.principal(grant);
  }
  /** Arms expiry for grants that were live when the daemon started. */
  watch(grants: readonly OutsideGrant[]): void {
    for (const grant of grants) this.principal(grant);
  }
  /** A grant's expiry changed: its timer follows. */
  rearm(grant: OutsideGrant): void {
    const entry = this.live.get(grant.id);
    if (!entry || entry.expiresAt === grant.expiresAt) return;
    entry.cancelTimer();
    entry.expiresAt = grant.expiresAt;
    entry.cancelTimer = this.arm(grant.id, grant.expiresAt);
  }
  /** Ends a grant's live principal (revoked or expired); safe to call more than once. */
  end(grantId: string): void {
    const entry = this.live.get(grantId);
    this.live.delete(grantId);
    entry?.cancelTimer();
    entry?.abort();
    this.ended(grantId);
  }
  close(): void {
    this.closed = true;
    for (const entry of this.live.values()) {
      entry.cancelTimer();
      entry.abort();
    }
    this.live.clear();
  }
  private principal(grant: OutsideGrant): Principal {
    const existing = this.live.get(grant.id);
    if (existing) return existing.principal;
    const controller = new AbortController();
    const principal: Principal = Object.freeze({
      scope: Object.freeze({ ...grantCaller(grant.id), capabilities }),
      signal: controller.signal,
    });
    this.live.set(grant.id, {
      principal,
      abort: () => controller.abort(),
      cancelTimer: this.arm(grant.id, grant.expiresAt),
      expiresAt: grant.expiresAt,
    });
    return principal;
  }
  private arm(grantId: string, expiresAt: number | null): () => void {
    if (expiresAt === null) return () => {};
    let cancel: (() => void) | undefined;
    const check = () => {
      const grant = this.grants.live(grantId);
      if (!grant) return this.end(grantId);
      const left = (grant.expiresAt ?? Infinity) - this.now();
      if (left === Infinity) return;
      cancel = this.scheduler.after(Math.max(1, Math.min(left, longestTimerMs)), check);
    };
    cancel = this.scheduler.after(
      Math.max(1, Math.min(expiresAt - this.now(), longestTimerMs)),
      check,
    );
    return () => cancel?.();
  }
}
