import { HostId, Ticket, ipKey } from "@ace/relay/wire";
import type { Env } from "./env.ts";

export { RelayObject } from "./relay-object.ts";

const endpoints = new Set(["/host", "/client", "/join"]);

function rateKey(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return "unknown";
  try {
    return ipKey(ip);
  } catch {
    return "unknown";
  }
}

/** Checks each upgrade and hands it to the Durable Object named by its host id. */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!endpoints.has(url.pathname))
      return url.pathname === "/"
        ? new Response("ace relay\n")
        : new Response(null, { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426 });
    const hostId = HostId.safeParse(url.searchParams.get("hostId"));
    if (!hostId.success) return new Response(null, { status: 400 });
    if (url.pathname === "/join" && !Ticket.safeParse(url.searchParams.get("ticket")).success)
      return new Response(null, { status: 400 });
    if (env.UPGRADES && !(await env.UPGRADES.limit({ key: rateKey(request) })).success)
      return new Response(null, { status: 429 });
    return env.RELAY.get(env.RELAY.idFromName(hostId.data)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
