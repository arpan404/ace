import type { HostHttpOptions, RelayHttpHandler } from "@ace/relay";
import type { SettingsService } from "@ace/settings";
import { hooksPath } from "./automation-webhooks.ts";

export type { RelayHttpHandler } from "@ace/relay";

/** Nothing is served on the relay path until the outside MCP endpoint runs. */
export const notServed: RelayHttpHandler = async () => new Response(null, { status: 404 });

/**
 * HTTP that ace's hosted relay forwards from `https://cloud.acehq.dev/m/<hostId>/…`: the outside
 * MCP endpoint with its OAuth endpoints and metadata (ADR 0122), and automations' webhooks under
 * `/hooks/` (ADR 0158). Each has its own setting, `remote.relayMcp` and `remote.relayWebhooks`,
 * read for every request; with both off, the relay answers 404 without reaching a handler, and a
 * request for the one that's off gets 404 here.
 *
 * The handlers are read per request too. The outside MCP server's Request-level handler plugs in
 * there (`ServerOptions.outsideMcpHttp`). Each request's URL is the public one the caller used,
 * `<origin><prefix><path>`, which is also the canonical resource URL to check tokens against.
 * Requests on this path carry the relay's host name, so the handler accepts that origin here
 * and only here; the localhost Host and Origin checks of the local listener stay as they are.
 */
export function relayHttp(options: {
  settings(): SettingsService | undefined;
  handler(): RelayHttpHandler | undefined;
  webhooks(): { enabled(): boolean; relay: RelayHttpHandler } | undefined;
}): HostHttpOptions {
  const mcpOn = async () => (await options.settings()?.get("remote.relayMcp"))?.value === true;
  return {
    enabled: async () => options.webhooks()?.enabled() === true || (await mcpOn()),
    handle: async (request, signal, forwarded) => {
      // Well-known OAuth paths arrive as `/.well-known/<name><prefix>/…`; only `<prefix>/hooks/`
      // is a webhook.
      if (new URL(request.url).pathname.startsWith(forwarded.prefix + hooksPath)) {
        const webhooks = options.webhooks();
        return webhooks?.enabled()
          ? webhooks.relay(request, signal, forwarded)
          : notServed(request, signal, forwarded);
      }
      if (!(await mcpOn())) return notServed(request, signal, forwarded);
      return (options.handler() ?? notServed)(request, signal, forwarded);
    },
  };
}
