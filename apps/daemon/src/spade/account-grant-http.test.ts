import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { GRANT_LIFETIME_MS, signGrant } from "@ace/account-grant";
import { AceAccountError } from "@ace/client/ace-account";
import {
  accountGrantHttp,
  accountGrantPath,
  type SpadeAccountGrant,
} from "./account-grant-http.ts";

const spadeBearer = "spade-grant-token";
const machineGrant = signGrant(
  { kind: "machine", account: "user_1", subject: "h".repeat(43), iat: 0, exp: GRANT_LIFETIME_MS },
  { id: "k1", privateKey: new Uint8Array(32).fill(3) },
);
let server: Server | undefined;
afterEach(() => server?.close());

async function serve(grant: SpadeAccountGrant): Promise<string> {
  const handler = accountGrantHttp({ verify: (bearer) => bearer === spadeBearer, grant });
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${accountGrantPath}`;
}

const ask = (url: string, bearer = spadeBearer) =>
  fetch(url, { method: "POST", headers: { authorization: `Bearer ${bearer}` } });

it("Spade's grant gets a fresh machine grant for the machine's ace account", async () => {
  const url = await serve(async () => ({ token: machineGrant, account: "user_1" }));
  const response = await ask(url);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    token: machineGrant,
    account: "user_1",
    expiresInMs: GRANT_LIFETIME_MS,
  });
});

it("any other bearer gets no machine grant", async () => {
  const url = await serve(async () => ({ token: machineGrant, account: "user_1" }));
  for (const response of [await ask(url, "someone-else"), await fetch(url, { method: "POST" })]) {
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(machineGrant);
  }
});

it("a signed-out machine answers signed_out, and so does one whose session the backend dropped", async () => {
  for (const grant of [
    async () => undefined,
    async () => Promise.reject(new AceAccountError(401)),
  ] satisfies SpadeAccountGrant[]) {
    const url = await serve(grant);
    const response = await ask(url);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "signed_out" });
    server?.close();
  }
});

it("an account backend that can't be reached answers unreachable, not signed out", async () => {
  const url = await serve(async () => Promise.reject(new AceAccountError(502)));
  const response = await ask(url);
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "unreachable" });
});
