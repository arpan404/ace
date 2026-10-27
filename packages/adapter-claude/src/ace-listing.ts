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
 * The wanted listing and the one Claude Code last accepted are kept apart: a replacement that
 * fails leaves the session wanting core, and the next model switch, turn or replacement tries
 * again until one succeeds.
 */
export class AceListing {
  private readonly connection: AceMcpConnection;
  private wanted: ToolListing;
  private installed: ToolListing;
  private servers: Record<string, unknown>;
  private inFlight: Promise<void> | undefined;
  constructor(
    connection: AceMcpConnection,
    listing: ToolListing,
    initial: Record<string, unknown>,
  ) {
    this.connection = connection;
    this.wanted = listing;
    this.installed = listing;
    this.servers = { ...initial, ...this.entry() };
  }
  /** A narrowing Claude Code has not accepted yet, so ace still needs reconnecting. */
  get unsettled(): boolean {
    return this.wanted !== this.installed;
  }
  /** These MCP controls, with every replacement keeping this session's ace entry. */
  controls(base: ProviderMcpControl): ProviderMcpControl {
    return {
      ...base,
      replace: async (servers) => {
        const listing = this.wanted;
        const next = { ...servers, ...this.entry() };
        const result = await base.replace(next);
        this.servers = next;
        this.installed = listing;
        return result;
      },
    };
  }
  /** Narrows the listing for the session's new facts; reconnects ace unless it already has it. */
  async update(facts: ClaudeToolSearchFacts, base: ProviderMcpControl): Promise<void> {
    this.wanted = claudeToolListingAfter(this.wanted, facts);
    await this.settle(base);
  }
  /** Reconnects ace when an earlier narrowing never reached Claude Code; a no-op otherwise. */
  settle(base: ProviderMcpControl): Promise<void> {
    if (!this.unsettled) return Promise.resolve();
    this.inFlight ??= this.controls(base)
      .replace(this.servers)
      .then(() => undefined)
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
  private entry() {
    return { ace: claudeAceServer(this.connection, this.wanted) };
  }
}
