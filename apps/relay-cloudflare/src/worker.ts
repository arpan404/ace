import { HTTP_MAX_REQUEST_BYTES, HostId, Ticket, ipKey } from "@ace/relay/wire";
import { accountApi, isAccountPath } from "./account/api.ts";
import type { AccountApi } from "./account/api.ts";
import { readAccountSetup } from "./account/config.ts";
import type { AccountSetup } from "./account/config.ts";
import { ACCOUNT_HEADER, EXCHANGE_HEADER, PROTOCOL_HEADER, admit } from "./admission.ts";
import type { Env } from "./env.ts";
import { forwardPath } from "./http-path.ts";
import type { ForwardPath } from "./http-path.ts";

export { RelayObject } from "./relay-object.ts";

const endpoints = new Set(["/host", "/client", "/join", "/serve"]);

function rateKey(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return "unknown";
  try {
    return ipKey(ip);
  } catch {
    return "unknown";
  }
}

async function limited(
  limit: RateLimit | undefined,
  request: Request,
  key = rateKey(request),
): Promise<boolean> {
  return limit ? !(await limit.limit({ key })).success : false;
}

const tooMany = () =>
  new Response("Too many requests.\n", {
    status: 429,
    headers: { "retry-after": "10", "content-type": "text/plain; charset=utf-8" },
  });

/**
 * Public HTTP for one machine (ADR 0117): checked and limited here, then handed to that
 * machine's relay object, which carries it to the daemon. Paths, headers and bodies are never
 * logged; the caller's account isn't checked, since the daemon authorizes every request.
 */
async function forwardHttp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  target: ForwardPath,
): Promise<Response> {
  if (await limited(env.HTTP_REQUESTS, request)) return tooMany();
  if (await limited(env.HTTP_HOST_REQUESTS, request, target.hostId)) return tooMany();
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length > HTTP_MAX_REQUEST_BYTES)
    return new Response("Request body too large.\n", { status: 413 });
  const relay = env.RELAY.get(env.RELAY.idFromName(target.hostId));
  // A caller leaving doesn't cancel the object's side of the request by itself; the Worker
  // sees it and tells the object, which cancels the daemon's work.
  const exchange = crypto.randomUUID();
  request.signal.addEventListener(
    "abort",
    () => ctx.waitUntil(relay.cancelHttp(exchange).catch(() => {})),
    { once: true },
  );
  const headers = new Headers(request.headers);
  headers.set(EXCHANGE_HEADER, exchange);
  return relay.fetch(new Request(request, { headers }));
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
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (isAccountPath(url.pathname))
      return accounts(env).api.handle(request, await limited(env.ACCOUNT_REQUESTS, request));
    const target = forwardPath(url);
    if (target) return forwardHttp(request, env, ctx, target);
    if (!endpoints.has(url.pathname))
      return url.pathname === "/"
        ? new Response("ace relay\n")
        : new Response(null, { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426 });
    const hostId = HostId.safeParse(url.searchParams.get("hostId"));
    if (!hostId.success) return new Response(null, { status: 400 });
    if (
      (url.pathname === "/join" || url.pathname === "/serve") &&
      !Ticket.safeParse(url.searchParams.get("ticket")).success
    )
      return new Response(null, { status: 400 });
    const name = url.searchParams.get("name") ?? "";
    const platform = url.searchParams.get("platform") ?? "";
    const features = url.searchParams.get("features") ?? "";
    if (name.length > 256 || platform.length > 64 || features.length > 64)
      return new Response(null, { status: 400 });
    if (await limited(env.UPGRADES, request)) return new Response(null, { status: 429 });
    const headers = new Headers(request.headers);
    headers.delete(ACCOUNT_HEADER);
    headers.delete(PROTOCOL_HEADER);
    headers.delete(EXCHANGE_HEADER);
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
