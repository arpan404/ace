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
 */
export class AceListing {
  private readonly connection: AceMcpConnection;
  private current: ToolListing;
  private servers: Record<string, unknown>;
  constructor(
    connection: AceMcpConnection,
    listing: ToolListing,
    initial: Record<string, unknown>,
  ) {
    this.connection = connection;
    this.current = listing;
    this.servers = { ...initial, ...this.entry() };
  }
  get listing(): ToolListing {
    return this.current;
  }
  /** These MCP controls, with every replacement keeping this session's ace entry. */
  controls(base: ProviderMcpControl): ProviderMcpControl {
    return {
      ...base,
      replace: async (servers) => {
        const next = { ...servers, ...this.entry() };
        const result = await base.replace(next);
        this.servers = next;
        return result;
      },
    };
  }
  /** Narrows the listing for the session's new facts; reconnects ace when it changed. */
  async update(facts: ClaudeToolSearchFacts, base: ProviderMcpControl): Promise<void> {
    const next = claudeToolListingAfter(this.current, facts);
    if (next === this.current) return;
    this.current = next;
    await this.controls(base).replace(this.servers);
  }
  private entry() {
    return { ace: claudeAceServer(this.connection, this.current) };
  }
}
