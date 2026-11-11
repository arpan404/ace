import type { HostHttpOptions, RelayHttpHandler } from "@ace/relay";
import type { SettingsService } from "@ace/settings";

export type { RelayHttpHandler } from "@ace/relay";

/** Nothing is served on the relay path until outside MCP grants land. */
export const notServed: RelayHttpHandler = async () => new Response(null, { status: 404 });

/**
 * HTTP that ace's hosted relay forwards from `https://relay.acehq.dev/m/<hostId>/…` (ADR 0117):
 * the MCP endpoint, its OAuth endpoints and their metadata. Off unless `remote.relayMcp` is on,
 * read for every request; off, the relay answers 404 without reaching a handler.
 *
 * `handler` is read per request too. The outside MCP server's Request-level handler plugs in
 * there (`ServerOptions.outsideMcpHttp`). Each request's URL is the public one the caller used,
 * `<origin><prefix><path>`, which is also the canonical resource URL to check tokens against.
 * Requests on this path carry the relay's host name, so the handler accepts that origin here
 * and only here; the localhost Host and Origin checks of the local listener stay as they are.
 */
export function relayHttp(options: {
  settings(): SettingsService | undefined;
  handler(): RelayHttpHandler | undefined;
}): HostHttpOptions {
  return {
    enabled: async () => (await options.settings()?.get("remote.relayMcp"))?.value === true,
    handle: (request, signal, forwarded) =>
      (options.handler() ?? notServed)(request, signal, forwarded),
  };
}
