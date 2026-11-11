import type { Principal } from "@ace/mcp-server";
import type { McpCapability, McpScope, OutsideGrant } from "@ace/protocol";
import type { SpadeHostThread } from "./host-thread.ts";

export interface SpadeLease {
  readonly principal: Principal;
  end(): void;
}
export interface SpadeGrantAuthOptions {
  /** The live Spade grant a bearer belongs to (SQLite, every call). */
  verify(bearer: string): OutsideGrant | undefined;
  /** Spade's host thread now; undefined while it is missing (it heals when Spade is turned on). */
  hostThread(): SpadeHostThread | undefined;
  /** The tool groups a provider session gets. */
  capabilities(): McpCapability[];
  /** Opens a lease on the daemon's MCP endpoint, as a provider session's is opened. */
  open(scope: McpScope, lifetime: AbortSignal): SpadeLease;
}

/**
 * Spade's grant on the daemon's own MCP endpoint (ADR 0123): a bearer of a live `spade` grant
 * acts as Spade's host thread with a provider session's tool groups, so it lists and calls what
 * the host thread's lease allows (no `ask`, no `browser_request_help`) and nothing else. One
 * lease is kept per grant and host thread; it ends when the grant ends or the thread changes,
 * which ends its calls and streams.
 */
export class SpadeGrantAuthenticator {
  private current:
    | { grantId: string; threadId: string; lease: SpadeLease; lifetime: AbortController }
    | undefined;
  private readonly options: SpadeGrantAuthOptions;
  private closed = false;
  constructor(options: SpadeGrantAuthOptions) {
    this.options = options;
  }
  authenticate(bearer: string): Principal | undefined {
    if (this.closed) return undefined;
    const grant = this.options.verify(bearer);
    if (!grant) return undefined;
    const thread = this.options.hostThread();
    if (!thread) return undefined;
    const held = this.current;
    if (
      held &&
      held.grantId === grant.id &&
      held.threadId === thread.threadId &&
      !held.lease.principal.signal.aborted
    )
      return held.lease.principal;
    this.endLease();
    const lifetime = new AbortController();
    const lease = this.options.open(
      {
        sessionId: `spade:${grant.id}`,
        threadId: thread.threadId,
        agentId: thread.agentId,
        capabilities: this.options.capabilities(),
      },
      lifetime.signal,
    );
    this.current = { grantId: grant.id, threadId: thread.threadId, lease, lifetime };
    return lease.principal;
  }
  /** A grant ended: its lease, if it holds one, ends now. Any grant when `grantId` is omitted. */
  end(grantId?: string): void {
    if (grantId === undefined || this.current?.grantId === grantId) this.endLease();
  }
  close(): void {
    this.closed = true;
    this.endLease();
  }
  private endLease(): void {
    const held = this.current;
    this.current = undefined;
    held?.lease.end();
    held?.lifetime.abort();
  }
}
