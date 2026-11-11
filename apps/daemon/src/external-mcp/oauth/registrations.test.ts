import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { grantDatabase } from "../grant-test-support.ts";
import {
  ClientRegistrations,
  evictableAfterMs,
  registrationCap,
  unusedRegistrationMs,
} from "./registrations.ts";

function registrations() {
  const { sql } = grantDatabase();
  const clock = { now: 1_000_000 };
  const open = () => new ClientRegistrations({ sql, now: () => clock.now, random: randomBytes });
  return { clock, open, store: open() };
}
const request = { client_name: "Inspector", redirect_uris: ["http://localhost:6274/cb"] };
function register(store: ClientRegistrations, body: unknown = request): string {
  const result = store.register(body);
  if (!("registered" in result)) throw new Error(result.description);
  return String(result.registered["client_id"]);
}

test("a registered client is a public, unverified client with its redirects", () => {
  const f = registrations();
  const result = f.store.register({
    ...request,
    token_endpoint_auth_method: "client_secret_basic",
  });
  if (!("registered" in result)) throw new Error("refused");
  expect(result.registered).toMatchObject({
    client_name: "Inspector",
    redirect_uris: ["http://localhost:6274/cb"],
    token_endpoint_auth_method: "none",
  });
  expect(result.registered).not.toHaveProperty("client_secret");
  const clientId = String(result.registered["client_id"]);
  expect(f.open().get(clientId)).toEqual({
    kind: "dcr",
    clientId,
    name: "Inspector",
    domain: null,
    redirectUris: ["http://localhost:6274/cb"],
  });
});

test("registrations without usable redirects are refused", () => {
  const f = registrations();
  expect(f.store.register({ redirect_uris: ["http://evil.example/cb"] })).toMatchObject({
    error: "invalid_redirect_uri",
  });
  expect(f.store.register({ client_name: "x" })).toMatchObject({
    error: "invalid_client_metadata",
  });
});

test("a registration never approved expires after a day; an approved one stays", () => {
  const f = registrations();
  const unused = register(f.store);
  const used = register(f.store);
  f.store.markUsed(used);
  f.clock.now += unusedRegistrationMs;
  expect(f.store.get(unused)).toBeUndefined();
  expect(f.store.get(used)).toBeDefined();
});

test("at the cap, fresh registrations are refused rather than pushing out recent ones", () => {
  const f = registrations();
  const first = register(f.store);
  for (let i = 1; i < registrationCap; i++) {
    f.clock.now += 1;
    register(f.store);
  }
  expect(f.store.register(request)).toMatchObject({
    error: "temporarily_unavailable",
    status: 503,
  });
  expect(f.store.get(first)).toBeDefined();
  // An hour on, the oldest one nobody used makes room.
  f.clock.now += evictableAfterMs;
  const newest = register(f.store);
  expect(f.store.get(first)).toBeUndefined();
  expect(f.store.get(newest)).toBeDefined();
});

test("Cursor's registration keeps all three of its redirects", () => {
  const f = registrations();
  // Cursor 3.14.27 sends these, with no application_type.
  const uris = [
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "https://www.cursor.com/agents/mcp/oauth/callback",
    "http://localhost:8787/callback",
  ];
  const result = f.store.register({ client_name: "Cursor", redirect_uris: uris });
  if (!("registered" in result)) throw new Error(result.description);
  expect(result.registered["redirect_uris"]).toEqual(uris);
});

test("unusable redirects are dropped from a registration that has usable ones", () => {
  const f = registrations();
  const result = f.store.register({
    redirect_uris: ["javascript:alert(1)", "https://client.example/cb", "http://evil.example/cb"],
  });
  if (!("registered" in result)) throw new Error(result.description);
  expect(result.registered["redirect_uris"]).toEqual(["https://client.example/cb"]);
});
