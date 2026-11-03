#!/usr/bin/env node
/*
 * Asks a deployed relay whether WorkOS accepts its own WorkOS credentials, without the key
 * ever leaving Cloudflare: the Worker checks them itself and answers with verdicts only.
 *
 *   bun run check:workos                       # https://relay.acehq.dev
 *   bun run check:workos https://relay.example
 *
 * Exits 0 when sign-in can work, 1 otherwise.
 */
import { z } from "zod";

const origin = (process.argv[2] ?? "https://relay.acehq.dev").replace(/\/+$/, "");
const Health = z.object({
  apiKey: z.enum(["accepted", "refused", "unreachable"]),
  keyFormat: z.enum(["ok", "unexpected"]),
  clientId: z.enum(["known", "unknown", "unreachable"]),
});

const response = await fetch(`${origin}/v1/account/health`, {
  signal: AbortSignal.timeout(20_000),
}).catch((error: unknown) => {
  console.error(`Couldn't reach ${origin}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
const body: unknown = await response.json().catch(() => undefined);
if (response.status === 503) {
  console.error("The relay's account settings are missing or malformed (account_not_configured).");
  process.exit(1);
}
if (response.status === 404) {
  console.error("This relay is older than the health check; deploy the current one first.");
  process.exit(1);
}
const health = Health.safeParse(body);
if (!response.ok || !health.success) {
  console.error(`Unexpected answer from ${origin}: ${response.status}`);
  process.exit(1);
}

const { apiKey, keyFormat, clientId } = health.data;
const lines = {
  apiKey: {
    accepted: "ok    WorkOS accepts the API key",
    refused: "fail  WorkOS refuses the API key: set WORKOS_API_KEY to the sk_… key alone",
    unreachable: "fail  WorkOS couldn't be reached to check the API key; try again",
  }[apiKey],
  keyFormat: {
    ok: "ok    the API key is one sk_… value",
    unexpected: "fail  the API key has extra text or spaces around it: paste only the sk_… value",
  }[keyFormat],
  clientId: {
    known: "ok    WorkOS knows the client id",
    unknown: "fail  WorkOS doesn't know WORKOS_CLIENT_ID: copy the client_… id again",
    unreachable: "fail  WorkOS couldn't be reached to check the client id; try again",
  }[clientId],
};
console.log(`${origin}\n${lines.apiKey}\n${lines.keyFormat}\n${lines.clientId}`);
process.exit(apiKey === "accepted" && keyFormat === "ok" && clientId === "known" ? 0 : 1);
