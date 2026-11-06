import { HostId, Ticket, ipKey } from "@ace/relay/wire";
import { accountApi, isAccountPath } from "./account/api.ts";
import type { AccountApi } from "./account/api.ts";
import { readAccountSetup } from "./account/config.ts";
import type { AccountSetup } from "./account/config.ts";
import { ACCOUNT_HEADER, PROTOCOL_HEADER, admit } from "./admission.ts";
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

async function limited(limit: RateLimit | undefined, request: Request): Promise<boolean> {
  return limit ? !(await limit.limit({ key: rateKey(request) })).success : false;
}

/** Account settings and the API built from them, once per isolate. */
const isolates = new WeakMap<Env, { setup: AccountSetup; api: AccountApi }>();
function accounts(env: Env) {
  let found = isolates.get(env);
  if (!found) {
    const setup = readAccountSetup(env);
    const api = accountApi(setup, {
      db: env.ACCOUNTS,
      fetch: (input, init) => fetch(input, init),
      now: () => Date.now(),
      random: (length) => crypto.getRandomValues(new Uint8Array(length)),
      forgotten: (hostId, accountId) =>
        env.RELAY.get(env.RELAY.idFromName(hostId)).registerAgain(accountId),
    });
    found = { setup, api };
    isolates.set(env, found);
  }
  return found;
}

/**
 * One Worker serves ace's account API under `/v1/` and the relay. Each relay upgrade is
 * checked here and handed to the Durable Object named by its host id.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (isAccountPath(url.pathname))
      return accounts(env).api.handle(request, await limited(env.ACCOUNT_REQUESTS, request));
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
    const name = url.searchParams.get("name") ?? "";
    const platform = url.searchParams.get("platform") ?? "";
    if (name.length > 256 || platform.length > 64) return new Response(null, { status: 400 });
    if (await limited(env.UPGRADES, request)) return new Response(null, { status: 429 });
    const headers = new Headers(request.headers);
    headers.delete(ACCOUNT_HEADER);
    headers.delete(PROTOCOL_HEADER);
    if (url.pathname === "/host" || url.pathname === "/client") {
      const admission = admit({
        endpoint: url.pathname,
        hostId: hostId.data,
        subprotocols: request.headers.get("Sec-WebSocket-Protocol"),
        setup: accounts(env).setup,
        now: Date.now(),
      });
      if (!admission.admitted) return new Response(null, { status: admission.status });
      headers.set(ACCOUNT_HEADER, admission.account);
      headers.set(PROTOCOL_HEADER, admission.protocol);
    }
    return env.RELAY.get(env.RELAY.idFromName(hostId.data)).fetch(
      new Request(request, { headers }),
    );
  },

  async scheduled(_controller, env): Promise<void> {
    await accounts(env).api.sweep();
  },
} satisfies ExportedHandler<Env>;
