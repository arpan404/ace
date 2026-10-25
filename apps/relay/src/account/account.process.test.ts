import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  AceAccountGrant,
  AceAccountSession,
  AceLogin,
  AceLoginStatus,
} from "@ace/protocol/ace-account";
import { startRelay } from "../server.ts";
import { readRelayConfig } from "../config.ts";
import type { AccountProvider } from "./workos.ts";
import { aceAccountClient } from "@ace/client/ace-account";

const disposals: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).toReversed()) await dispose();
});
const user = { id: "user_ace", email: "person@example.com", name: "Ace Person" };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ace-account-"));
  disposals.push(() => rm(directory, { recursive: true, force: true }));
  let current = 1_800_000_000_000;
  let failure: string | undefined;
  let complete: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const exchangeStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let exchangeBarrier: Promise<void> | undefined;
  const provider: AccountProvider = {
    async authorize() {
      return {
        url: "https://workos.example/authorize",
        state: "server-state",
        codeVerifier: "server-verifier",
      };
    },
    async exchange(code, verifier) {
      if (code !== "valid-code" || verifier !== "server-verifier") throw new Error("Rejected code");
      entered?.();
      if (exchangeBarrier) await exchangeBarrier;
      return { account: user, refreshToken: "workos-refresh-never-on-disk" };
    },
    async refresh(token) {
      if (failure) throw Object.assign(new Error("Provider failure"), { code: failure });
      if (!token.startsWith("workos-refresh")) throw new Error("Wrong refresh token");
      return { account: user, refreshToken: "workos-refresh-rotated" };
    },
  };
  const options = {
    account: {
      publicUrl: "http://127.0.0.1",
      clientId: "client_test",
      apiKey: "test-only",
      encryptionKey: "ab".repeat(32),
      dataDir: directory,
      allowedOrigins: ["https://app.example", "app://ace"],
    },
    accountProvider: provider,
    accountNow: () => current,
  };
  let relay = await startRelay(options);
  disposals.push(() => relay.close());
  const address = () => relay.url.replace("ws:", "http:");
  const request = (path: string, init?: RequestInit) =>
    fetch(address() + path, { redirect: "manual", ...init });
  async function begin() {
    const started = await request("/v1/account/login", {
      method: "POST",
      headers: { Origin: "https://app.example" },
    });
    expect(started.status).toBe(201);
    expect(started.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const flow = AceLogin.parse(await started.json());
    const opened = await request(`/v1/account/login?id=${flow.id}`);
    expect(opened.status).toBe(302);
    const cookie = opened.headers.get("set-cookie")?.split(";")[0] ?? "";
    return { flow, cookie };
  }
  const callback = (cookie: string) =>
    request("/v1/account/callback?state=server-state&code=valid-code", { headers: { cookie } });
  const poll = (flow: AceLogin) =>
    request(`/v1/account/login/${flow.id}`, {
      headers: { Authorization: `Bearer ${flow.secret}` },
    });
  async function signedIn() {
    const { flow, cookie } = await begin();
    expect((await callback(cookie)).status).toBe(200);
    const status = AceLoginStatus.parse(await (await poll(flow)).json());
    if (status.status !== "complete") throw new Error("Sign-in did not finish");
    return { flow, grant: status.session };
  }
  return {
    begin,
    callback,
    poll,
    request,
    signedIn,
    directory,
    exchangeStarted,
    advance(ms: number) {
      current += ms;
      relay.sweep();
    },
    fail(code?: string) {
      failure = code;
    },
    blockExchange() {
      exchangeBarrier = new Promise((resolve) => {
        complete = resolve;
      });
    },
    completeExchange() {
      complete?.();
    },
    async restart() {
      await relay.close();
      relay = await startRelay(options);
    },
    address,
  };
}

it("only the initiating browser and private claim ticket can complete ace sign-in", async () => {
  const app = await fixture();
  const { flow, cookie } = await app.begin();
  expect((await app.callback("")).status).toBe(400);
  expect((await app.callback(cookie.replace(/=.+$/, "=forged"))).status).toBe(400);
  const hidden = await app.request(`/v1/account/login/${flow.id}`);
  expect(hidden.status).toBe(401);
  expect((await app.callback(cookie)).status).toBe(200);
  expect((await app.callback(cookie)).status).toBe(400);
  const response = await app.poll(flow);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const status = AceLoginStatus.parse(await response.json());
  expect(status.status).toBe("complete");
  // A lost claim response can be retried with the same private ticket.
  expect(await (await app.poll(flow)).json()).toEqual(status);
});

it("ace sessions survive relay restarts, encrypt WorkOS tokens and revoke immediately on sign-out", async () => {
  const app = await fixture();
  const { grant } = await app.signedIn();
  await app.restart();
  const headers = { Authorization: `Bearer ${grant.token}` };
  const restored = await app.request("/v1/account/session", { headers });
  expect(AceAccountSession.parse(await restored.json()).account).toEqual(user);
  const disk = Buffer.concat(
    await Promise.all([
      readFile(join(app.directory, "accounts.sqlite")),
      readFile(join(app.directory, "accounts.sqlite-wal")),
    ]),
  );
  expect(disk.indexOf(Buffer.from("workos-refresh"))).toBe(-1);
  expect(disk.indexOf(Buffer.from(grant.token))).toBe(-1);
  expect((await app.request("/v1/account/session", { method: "DELETE", headers })).status).toBe(
    200,
  );
  expect((await app.request("/v1/account/session", { headers })).status).toBe(401);
  await app.restart();
  expect((await app.request("/v1/account/session", { headers })).status).toBe(401);
});

it("provider revocation ends an ace session while transient failures leave it retryable", async () => {
  const app = await fixture();
  const { grant } = await app.signedIn();
  const headers = { Authorization: `Bearer ${grant.token}` };
  app.fail("temporarily_unavailable");
  expect((await app.request("/v1/account/session", { headers })).status).toBe(503);
  app.fail();
  expect((await app.request("/v1/account/session", { headers })).status).toBe(200);
  app.fail("invalid_grant");
  expect((await app.request("/v1/account/session", { headers })).status).toBe(401);
  app.fail();
  expect((await app.request("/v1/account/session", { headers })).status).toBe(401);
});

it("cancelled and expired browser sign-ins cannot create a usable ace session", async () => {
  const app = await fixture();
  const { flow, cookie } = await app.begin();
  app.blockExchange();
  const callback = app.callback(cookie);
  await app.exchangeStarted;
  await app.request(`/v1/account/login/${flow.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${flow.secret}` },
  });
  app.completeExchange();
  expect((await callback).status).toBe(410);
  expect((await app.poll(flow)).status).toBe(401);
  const next = await app.begin();
  app.advance(10 * 60_000);
  expect((await app.callback(next.cookie)).status).toBe(400);
  expect((await app.poll(next.flow)).status).toBe(401);
});

it("unapproved web origins cannot start or read account flows", async () => {
  const app = await fixture();
  expect(
    (
      await app.request("/v1/account/login", {
        method: "POST",
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
  const preflight = await app.request("/v1/account/session", {
    method: "OPTIONS",
    headers: { Origin: "app://ace" },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("app://ace");
  expect(() => readRelayConfig({ WORKOS_CLIENT_ID: "client_partial" })).toThrow();
});

it("the shared account client signs in and signs out through the relay HTTP API", async () => {
  const app = await fixture();
  const client = aceAccountClient({
    origin: app.address(),
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      // The fixture uses an ephemeral port; the configured public origin deliberately has none.
      if (String(input).endsWith("/v1/account/login")) {
        const login = AceLogin.parse(await response.json());
        return Response.json(
          { ...login, loginUrl: `${app.address()}/v1/account/login?id=${login.id}` },
          { status: 201 },
        );
      }
      return response;
    },
  });
  const signal = AbortSignal.timeout(15_000);
  const login = await client.login(signal);
  expect(await client.poll(login, signal)).toEqual({ status: "pending" });
  const opened = await fetch(login.loginUrl, { redirect: "manual" });
  expect((await app.callback(opened.headers.get("set-cookie")?.split(";")[0] ?? "")).status).toBe(
    200,
  );
  const status = await client.poll(login, signal);
  if (status.status !== "complete") throw new Error("Expected account session");
  const grant = AceAccountGrant.parse(status.session);
  expect((await client.session(grant.token, signal)).account.email).toBe(user.email);
  await client.logout(grant.token, signal);
  await expect(client.session(grant.token, signal)).rejects.toMatchObject({ status: 401 });
});
