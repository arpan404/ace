import {
  claudeAceServer,
  claudeToolListingAfter,
  type AceMcpConnection,
  type ClaudeToolSearchFacts,
  type ToolListing,
} from "@ace/mcp-server";
import type { ProviderMcpControl } from "@ace/engine-api";

/**
 * How this session lists ace's tools, and ace's server entry to match. Claude Code decides on
 * tool search per request by the request's model, so a model switch can turn it off: the
 * listing then narrows to core and ace's server is reconnected with it. Every replacement of
 * the MCP set carries this session's entry, so a caller's copy of ace's server never widens it.
 *
 * Every replacement, a caller's or ace's own reconnect, runs one at a time and is built when it
 * runs from the latest intended set, so a reconnect never resubmits a set a caller has since
 * replaced. The intended set and the one Claude Code last accepted are kept apart: a replacement
 * that fails leaves the session unsettled, and the next model switch, turn or replacement tries
 * again until one succeeds.
 */
export class AceListing {
  private readonly connection: AceMcpConnection;
  private wanted: ToolListing;
  private installed: ToolListing;
  private intended: Record<string, unknown>;
  /** Bumped by each caller's replacement; `accepted` is the newest one Claude Code took. */
  private intent = 0;
  private accepted = 0;
  private tail: Promise<unknown> = Promise.resolve();
  /** A reconnect queued behind other replacements and not started yet; there is at most one. */
  private retry: Promise<void> | undefined;
  constructor(
    connection: AceMcpConnection,
    listing: ToolListing,
    initial: Record<string, unknown>,
  ) {
    this.connection = connection;
    this.wanted = listing;
    this.installed = listing;
    this.intended = initial;
  }
  /** Claude Code has not accepted the intended set or listing yet, so ace needs reconnecting. */
  get unsettled(): boolean {
    return this.wanted !== this.installed || this.accepted !== this.intent;
  }
  /** These MCP controls, with every replacement keeping this session's ace entry. */
  controls(base: ProviderMcpControl): ProviderMcpControl {
    return {
      ...base,
      replace: (servers) => {
        this.intended = servers;
        this.intent += 1;
        return this.queue(() => this.submit(base));
      },
    };
  }
  /** Narrows the listing for the session's new facts; reconnects ace unless it already has it. */
  async update(facts: ClaudeToolSearchFacts, base: ProviderMcpControl): Promise<void> {
    this.wanted = claudeToolListingAfter(this.wanted, facts);
    await this.settle(base);
  }
  /** Reconnects ace when an earlier replacement never reached Claude Code; a no-op otherwise. */
  settle(base: ProviderMcpControl): Promise<void> {
    if (!this.unsettled) return Promise.resolve();
    this.retry ??= this.queue(async () => {
      this.retry = undefined;
      // A replacement queued ahead of this one may have settled the session already.
      if (this.unsettled) await this.submit(base);
    });
    return this.retry;
  }
  /** Sends the latest intended set with ace's entry; only an accepted set counts as installed. */
  private async submit(base: ProviderMcpControl): Promise<unknown> {
    const listing = this.wanted;
    const intent = this.intent;
    const result = await base.replace({
      ...this.intended,
      ace: claudeAceServer(this.connection, listing),
    });
    this.installed = listing;
    this.accepted = Math.max(this.accepted, intent);
    return result;
  }
  private queue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job);
    this.tail = run.catch(() => {});
    return run;
  }
}
