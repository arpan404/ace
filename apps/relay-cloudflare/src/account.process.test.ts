import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  AceAccountSession,
  AceLogin,
  AceLoginStatus,
  type AceAccountGrant,
} from "@ace/protocol/ace-account";
import { aceAccountClient } from "@ace/client/ace-account";
import { GRANT_LIFETIME_MS, GrantKeySet, verifyGrant } from "@ace/account-grant";
import { DeviceId } from "@ace/protocol";
import { connectClientViaRelay, connectHostToRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import { deferred } from "@ace/relay/testing";
import { hostId, keyPair } from "@ace/secure-channel";
import { fakeWorkos } from "./testing/fake-workos.ts";
import type { WorkosUser } from "./testing/fake-workos.ts";
import { allowedOrigin, startWorker } from "./testing/harness.ts";
import { continueSignIn } from "./testing/sign-in.ts";

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
const cleanups: (() => unknown)[] = [];
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({ workosUrl: workos.url });
});
afterEach(async () => {
  workos.fail();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
afterAll(async () => {
  await worker.close();
  await workos.close();
});

const personA: WorkosUser = {
  id: "user_a",
  email: "a@example.com",
  first_name: "Ace",
  last_name: "Person",
};
const personB: WorkosUser = {
  id: "user_b",
  email: "b@example.com",
  first_name: "Bea",
  last_name: null,
};
let codes = 0;

const request = (path: string, init?: RequestInit) =>
  fetch(worker.http + path, { redirect: "manual", ...init });
const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** The app starts a sign-in and the person's browser opens its link and continues to WorkOS. */
async function begin() {
  const started = await request("/v1/account/login", {
    method: "POST",
    headers: { Origin: allowedOrigin },
  });
  expect(started.status).toBe(201);
  expect(started.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
  const flow = AceLogin.parse(await started.json());
  const continued = await continueSignIn(worker.http, flow.loginUrl);
  expect(continued.status).toBe(302);
  return { flow, cookie: continued.cookie, authorizeUrl: continued.authorizeUrl };
}

/** The person signs in at WorkOS, which sends their browser back with a code. */
function returnFromWorkos(
  started: { cookie: string; authorizeUrl: string },
  person = personA,
  cookie = started.cookie,
) {
  const code = `code-${++codes}`;
  const state = workos.authorize(started.authorizeUrl, person, code);
  return request(`/v1/account/callback?state=${state}&code=${code}`, { headers: { cookie } });
}

const poll = (flow: AceLogin) => request(`/v1/account/login/${flow.id}`, bearer(flow.secret));

async function signedIn(person = personA): Promise<AceAccountGrant> {
  const started = await begin();
  expect((await returnFromWorkos(started, person)).status).toBe(200);
  const status = AceLoginStatus.parse(await (await poll(started.flow)).json());
  if (status.status !== "complete") throw new Error("Sign-in did not finish");
  return status.session;
}

it("only the initiating browser and the private claim ticket can complete ace sign-in", async () => {
  const started = await begin();
  const { flow, cookie } = started;
  expect((await request(`/v1/account/login?id=${flow.id}`)).status).toBe(410);
  expect((await returnFromWorkos(started, personA, "")).status).toBe(400);
  expect((await returnFromWorkos(started, personA, cookie.replace(/=.+$/, "=forged"))).status).toBe(
    400,
  );
  expect((await request(`/v1/account/login/${flow.id}`)).status).toBe(401);
  expect(await (await poll(flow)).json()).toEqual({ status: "pending" });
  expect((await returnFromWorkos(started)).status).toBe(200);
  expect((await returnFromWorkos(started)).status).toBe(410);
  const response = await poll(flow);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const status = AceLoginStatus.parse(await response.json());
  expect(status).toMatchObject({
    status: "complete",
    session: { account: { id: "user_a", email: "a@example.com", name: "Ace Person" } },
  });
  // A lost claim response can be retried with the same private ticket.
  expect(await (await poll(flow)).json()).toEqual(status);
});

it("ace keeps no usable token at rest and sign-out ends the session at once", async () => {
  const grant = await signedIn();
  const rows = JSON.stringify([
    ...(await worker.db.prepare("SELECT * FROM sessions").all()).results,
    ...(await worker.db.prepare("SELECT * FROM logins").all()).results,
  ]);
  expect(rows).not.toContain(grant.token);
  expect(rows).not.toContain("workos-refresh");
  const session = await request("/v1/account/session", bearer(grant.token));
  expect(AceAccountSession.parse(await session.json()).account.name).toBe("Ace Person");
  const signOut = await request("/v1/account/session", {
    method: "DELETE",
    ...bearer(grant.token),
  });
  expect(signOut.status).toBe(200);
  expect((await request("/v1/account/session", bearer(grant.token))).status).toBe(401);
});

it("WorkOS revocation ends an ace session while WorkOS outages leave it retryable", async () => {
  const grant = await signedIn();
  const read = () => request("/v1/account/session", bearer(grant.token));
  workos.fail("unavailable");
  expect((await read()).status).toBe(503);
  workos.fail();
  expect((await read()).status).toBe(200);
  workos.fail("invalid_grant");
  expect((await read()).status).toBe(401);
  workos.fail();
  expect((await read()).status).toBe(401);
});

it("concurrent session reads never spend the same WorkOS refresh token twice", async () => {
  const grant = await signedIn();
  const read = () => request("/v1/account/session", bearer(grant.token));
  const statuses = await Promise.all(Array.from({ length: 6 }, async () => (await read()).status));
  expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  expect((await read()).status).toBe(200);
});

it("a sign-in cancelled while WorkOS answers cannot create a usable ace session", async () => {
  const started = await begin();
  const held = workos.hold();
  const callback = returnFromWorkos(started);
  await held.started;
  const cancel = await request(`/v1/account/login/${started.flow.id}`, {
    method: "DELETE",
    ...bearer(started.flow.secret),
  });
  expect(cancel.status).toBe(200);
  held.release();
  expect((await callback).status).toBe(410);
  expect((await poll(started.flow)).status).toBe(401);
  const sessions = await worker.db.prepare("SELECT count(*) AS n FROM sessions").first("n");
  const after = await signedIn();
  await request("/v1/account/session", { method: "DELETE", ...bearer(after.token) });
  expect(await worker.db.prepare("SELECT count(*) AS n FROM sessions").first("n")).toBe(sessions);
});

it("expired and refused sign-ins cannot be completed", async () => {
  const late = await begin();
  await worker.db.prepare("UPDATE logins SET expires = 1 WHERE expires > ?").bind(Date.now()).run();
  expect((await returnFromWorkos(late)).status).toBe(410);
  expect((await poll(late.flow)).status).toBe(401);
  const refused = await begin();
  const state = workos.authorize(refused.authorizeUrl, personA, "unused");
  const denied = await request(`/v1/account/callback?state=${state}&error=access_denied`, {
    headers: { cookie: refused.cookie },
  });
  expect(denied.status).toBe(400);
  expect(await (await poll(refused.flow)).json()).toEqual({ error: "login_failed" });
});

it("unapproved web origins cannot start or read account flows", async () => {
  const denied = await request("/v1/account/login", {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
  });
  expect(denied.status).toBe(403);
  const preflight = await request("/v1/account/session", {
    method: "OPTIONS",
    headers: { Origin: "app://ace" },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("app://ace");
});

it("grants need a live session and a machine grant names a host id", async () => {
  const grant = await signedIn();
  const post = (body: unknown, token = grant.token) =>
    request("/v1/grants", { method: "POST", body: JSON.stringify(body), ...bearer(token) });
  expect((await post({ kind: "device", subject: "phone" }, "x".repeat(43))).status).toBe(401);
  expect((await post({ kind: "machine", subject: "not-a-host" })).status).toBe(400);
  expect((await post({ kind: "owner", subject: "phone" })).status).toBe(400);
  await request("/v1/account/session", { method: "DELETE", ...bearer(grant.token) });
  expect((await post({ kind: "device", subject: "phone" })).status).toBe(401);
});

it("a signed-in machine and device reach each other through the account, and only its owner forgets it", async () => {
  const client = aceAccountClient({
    origin: worker.http,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      // The Worker's public origin has no port; the test harness listens on an ephemeral one.
      if (String(input).endsWith("/v1/account/login")) {
        const login = AceLogin.parse(await response.json());
        return Response.json(
          { ...login, loginUrl: `${worker.http}/v1/account/login?id=${login.id}` },
          { status: 201 },
        );
      }
      return response;
    },
  });
  const signal = AbortSignal.timeout(20_000);
  async function signIn(person: WorkosUser) {
    const login = await client.login(signal);
    expect(await client.poll(login, signal)).toEqual({ status: "pending" });
    const started = await continueSignIn(worker.http, login.loginUrl);
    expect((await returnFromWorkos(started, person)).status).toBe(200);
    const status = await client.poll(login, signal);
    if (status.status !== "complete") throw new Error("Expected an ace session");
    return status.session.token;
  }
  const owner = await signIn(personA);
  const hostKeys = keyPair();
  const keys = GrantKeySet.parse(await (await request("/v1/keys")).json());
  const machineGrant = await client.grant(
    owner,
    { kind: "machine", subject: hostId(hostKeys.publicKey) },
    signal,
  );
  const claims = verifyGrant(machineGrant.token, keys, Date.now(), "machine");
  expect(claims.account).toBe("user_a");
  expect(claims.exp - claims.iat).toBe(GRANT_LIFETIME_MS);

  const channel = deferred<HostChannel>();
  const machine = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys,
    account: {
      grant: async () =>
        (await client.grant(owner, { kind: "machine", subject: claims.subject }, signal)).token,
      name: "Build box",
      platform: "linux",
    },
    onClientChannel: channel.resolve,
  });
  cleanups.push(() => machine.close());
  expect(await client.machines(owner, signal)).toEqual([
    {
      hostId: machine.hostId,
      name: "Build box",
      platform: "linux",
      lastSeenAt: expect.any(Number),
    },
  ]);
  const device = await connectClientViaRelay({
    relayUrl: worker.relayUrl,
    hostId: machine.hostId,
    pinnedFingerprint: machine.hostId,
    grant: (await client.grant(owner, { kind: "device", subject: "phone" }, signal)).token,
  });
  cleanups.push(() => device.close());
  await device.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
  });
  expect(await (await channel.promise).receive()).toMatchObject({ type: "hello" });

  const stranger = await signIn(personB);
  expect(await client.machines(stranger, signal)).toEqual([]);
  await expect(client.forgetMachine(stranger, machine.hostId, signal)).rejects.toMatchObject({
    status: 404,
  });
  await client.forgetMachine(owner, machine.hostId, signal);
  expect(await client.machines(owner, signal)).toEqual([]);
  await client.logout(owner, signal);
  await expect(client.session(owner, signal)).rejects.toMatchObject({ status: 401 });
  await expect(
    client.grant(owner, { kind: "device", subject: "phone" }, signal),
  ).rejects.toMatchObject({ status: 401 });
});
