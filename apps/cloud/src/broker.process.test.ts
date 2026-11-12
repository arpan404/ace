import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GRANT_LIFETIME_MS, signCloudGrant } from "@ace/account-grant";
import { hostId, keyPair } from "@ace/secure-channel";
import { open } from "./broker/seal.ts";
import { SIGN_IN_MS } from "./broker/sign-ins.ts";
import { spadeSide } from "./broker/testing.ts";
import { fakeWorkos } from "./testing/fake-workos.ts";
import { grantKey, mint, startWorker, upgrade } from "./testing/harness.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

/*
 * The broker in the real runtime: its Durable Object, the credential the account API mints,
 * and ace cloud's two hostnames. The protocol's cases are in broker/broker.test.ts.
 */

const tokenRequests: URLSearchParams[] = [];
const maker = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  request.on("end", () => {
    tokenRequests.push(new URLSearchParams(raw));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1" }));
  });
});

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
beforeAll(async () => {
  await new Promise<void>((resolve) => maker.listen(0, "127.0.0.1", resolve));
  const { port } = maker.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  workos = await fakeWorkos();
  worker = await startWorker({
    workosUrl: workos.url,
    vars: {
      SPADE_CLOUD_APPS: JSON.stringify([
        {
          id: "asana",
          name: "Asana",
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          client_auth: "client_secret_post",
          resource: `${origin}/mcp`,
          client_id_env: "ASANA_ID",
          client_secret_env: "ASANA_SECRET",
        },
      ]),
      ASANA_ID: "asana-client",
      ASANA_SECRET: "asana-secret",
    },
  });
});
afterAll(async () => {
  await worker.close();
  await workos.close();
  await new Promise<void>((resolve) => maker.close(() => resolve()));
});

function cloudCredential(account: string) {
  const iat = Date.now();
  return signCloudGrant(
    { kind: "machine", account, subject: "A".repeat(52), iat, exp: iat + GRANT_LIFETIME_MS },
    grantKey,
  );
}

function post(base: string, path: string, grant: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${grant}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function start(grant: string, seed: number) {
  const spade = spadeSide(seed);
  const response = await post(worker.http, "/v1/oauth/asana/start", grant, {
    code_challenge: spade.challenge,
    public_key: spade.publicKey,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sign_in: string; authorization_url: string };
  const state = new URL(body.authorization_url).searchParams.get("state") ?? "";
  return {
    spade,
    handle: body.sign_in,
    state,
    finish: (as = grant) =>
      post(worker.http, "/v1/oauth/asana/finish", as, {
        sign_in: body.sign_in,
        code_verifier: spade.verifier,
      }),
  };
}

it("a credential the account API mints signs in through the broker once, and only once", async () => {
  const session = await signInThroughWorker(worker.http, workos, {
    id: "user_broker",
    email: "b@example.com",
    first_name: "Bea",
    last_name: null,
  });
  const minted = await fetch(`${worker.http}/v1/grants`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "machine",
      subject: hostId(keyPair().publicKey),
      purpose: "spade-cloud",
    }),
  });
  const { token } = (await minted.json()) as { token: string };
  const signIn = await start(token, 1);
  expect((await signIn.finish()).status).toBe(202);
  const page = await fetch(
    `${worker.http}/v1/oauth/callback/asana?state=${signIn.state}&code=the-code`,
  );
  expect(page.status).toBe(200);
  const replayed = await fetch(
    `${worker.http}/v1/oauth/callback/asana?state=${signIn.state}&code=other`,
  );
  expect(replayed.status).toBe(400);

  const done = await signIn.finish();
  expect(done.status).toBe(200);
  const { sealed } = (await done.json()) as { sealed: { epk: string; ciphertext: string } };
  const tokens = open(sealed, { app: "asana", purpose: "finish" }, signIn.spade.privateKey);
  expect(JSON.parse(new TextDecoder().decode(tokens))).toEqual({
    access_token: "access-1",
    refresh_token: "refresh-1",
  });
  expect(tokenRequests.at(-1)?.get("code")).toBe("the-code");
  expect((await signIn.finish()).status).toBe(404);
});

it("another account can't finish a sign-in, and its Durable Object lets it run out", async () => {
  const signIn = await start(cloudCredential("user_late"), 3);
  await fetch(`${worker.http}/v1/oauth/callback/asana?state=${signIn.state}&code=c`);
  const stolen = await signIn.finish(cloudCredential("user_thief"));
  expect(await stolen.json()).toEqual({ error: "unknown_sign_in" });

  const object = worker.env.SIGN_INS.get(worker.env.SIGN_INS.idFromName("user_late"));
  const later = await object.finish(
    {
      handle: signIn.handle,
      account: "user_late",
      app: "asana",
      verifier: signIn.spade.verifier,
    },
    Date.now() + SIGN_IN_MS,
  );
  expect(later).toEqual({ kind: "expired" });
  expect(await (await signIn.finish()).json()).toEqual({ error: "unknown_sign_in" });
});

it("a cloud credential opens no relay socket, and a relay grant starts no sign-in", async () => {
  const id = hostId(keyPair().publicKey);
  const cloud = cloudCredential("user_a");
  for (const endpoint of ["host", "client"])
    expect(
      await upgrade(`${worker.relayUrl}/${endpoint}?hostId=${id}`, [`ace.grant.${cloud}`]),
    ).toEqual({ status: 401 });
  const spade = spadeSide(5);
  const body = { code_challenge: spade.challenge, public_key: spade.publicKey };
  for (const grant of [mint("machine", "user_a", id), mint("device", "user_a", "phone")]) {
    const refused = await post(worker.http, "/v1/oauth/asana/start", grant, body);
    expect(refused.status).toBe(401);
  }
});

it("cloud.acehq.dev and relay.acehq.dev are one service", async () => {
  const keys = await Promise.all(
    ["https://cloud.acehq.dev", "https://relay.acehq.dev"].map(async (origin) => {
      const response = await worker.dispatch(`${origin}/v1/keys`);
      return response.json();
    }),
  );
  expect(keys[0]).toEqual(keys[1]);
  const spade = spadeSide(7);
  for (const origin of ["https://cloud.acehq.dev", "https://relay.acehq.dev"]) {
    const started = await worker.dispatch(`${origin}/v1/oauth/asana/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cloudCredential("user_hosts")}` },
      body: JSON.stringify({ code_challenge: spade.challenge, public_key: spade.publicKey }),
    });
    expect(started.status).toBe(200);
  }
  expect(await (await worker.dispatch("https://cloud.acehq.dev/")).text()).toBe("ace cloud\n");
});
