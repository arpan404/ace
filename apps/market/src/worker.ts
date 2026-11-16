import { readRoute } from "./api-read.ts";
import { publish, withdraw } from "./api-publish.ts";
import { signerRoute } from "./api-signer.ts";
import type { Context } from "./context.ts";
import type { Env } from "./env.ts";
import { configuredKeys, defaultKeysUrl, fetchedKeys, type KeySource } from "./grant-keys.ts";
import { failure, notFound, tooMany } from "./http.ts";
import { aggregateDownloads } from "./store/downloads.ts";
import { missingPage404, pageRoute } from "./pages/serve.ts";
import { isPublicRead, isSigner, matchRoute, type Route } from "./routes.ts";

/*
 * ace's marketplace Worker (ADR 0168): the thin shell. It reads the clock, makes ids and
 * fetches grant keys for the handlers, and limits callers by address through the rate-limit
 * bindings, which keep their counts in memory; it stores nothing about who asked.
 */

/** Grant keys per isolate, so a fetched set is reused for a few minutes. */
const keySources = new WeakMap<Env, KeySource>();
function grantKeys(env: Env): KeySource {
  let source = keySources.get(env);
  if (!source) {
    source = env.ACE_GRANT_KEYS
      ? configuredKeys(env.ACE_GRANT_KEYS)
      : fetchedKeys({
          url: env.ACE_ACCOUNT_KEYS_URL ?? defaultKeysUrl,
          fetch: (url) => fetch(url, { headers: { accept: "application/json" } }),
          now: () => Date.now(),
        });
    keySources.set(env, source);
  }
  return source;
}

function publisherId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `pub_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function limited(limit: RateLimit | undefined, request: Request): Promise<boolean> {
  if (!limit) return false;
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  return !(await limit.limit({ key })).success;
}

async function dispatch(
  request: Request,
  url: URL,
  route: Route,
  context: Context,
): Promise<Response> {
  switch (route.kind) {
    case "publish":
      return publish(request, url, route, context);
    case "withdraw":
      return withdraw(request, route, context);
    default:
      return (
        (await signerRoute(request, route, context)) ??
        (await readRoute(request, url, route, context)) ??
        (await pageRoute(url, route, context)) ??
        notFound()
      );
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const matched = matchRoute(request.method, url.pathname);
    if ("refused" in matched) {
      if (matched.refused === 405) return failure(405, "method", "That method isn't allowed here.");
      return url.pathname.startsWith("/v1/") ? notFound() : missingPage404();
    }
    const { route } = matched;
    // The signer is one maintainer's tool behind a long secret; it isn't limited.
    const limit = isPublicRead(route) ? env.READS : isSigner(route) ? undefined : env.PUBLISHES;
    if (await limited(limit, request)) return tooMany();
    const context: Context = {
      env,
      now: Date.now(),
      waitUntil: (promise) => ctx.waitUntil(promise),
      grantKeys: grantKeys(env),
      newId: publisherId,
    };
    return dispatch(request, url, route, context);
  },
  /** The cron: folds new download totals into the index's changes. */
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(aggregateDownloads(env.MARKET, Date.now()));
  },
} satisfies ExportedHandler<Env>;
