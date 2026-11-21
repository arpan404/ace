import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { GRANT_SUBPROTOCOL_PREFIX, GrantKeySet, encodeBase64url } from "@ace/account-grant";
import { machineCredentialProof } from "@ace/account-grant/machine-proof";
import { AceLogin } from "@ace/protocol/ace-account";
import { address } from "@ace/relay/testing";
import { hostId, keyPair } from "@ace/secure-channel";
import { WebSocket } from "ws";
import { fakeWorkos } from "./testing/fake-workos.ts";
import type { WorkosUser } from "./testing/fake-workos.ts";
import { allowedOrigin, mint, startWorker } from "./testing/harness.ts";
import { continueSignIn, signInThroughWorker } from "./testing/sign-in.ts";

/*
 * Deleting an account while something else is in flight for it: each test holds one step at
 * (fake) WorkOS, changes what the deletion depends on in the meantime, then lets it finish.
 * A real Worker, D1 and relay object, because the guarantees live in their SQL and sockets.
 */

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({ workosUrl: workos.url });
});
afterEach(() => workos.failDeletes(false));
afterAll(async () => {
  await worker.close();
  await workos.close();
});

const person = (id: string): WorkosUser => ({
  id,
  email: `${id}@example.com`,
  first_name: "Ace",
  last_name: null,
});
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const signIn = (id: string) => signInThroughWorker(worker.http, workos, person(id));
const deleteAccount = (token: string) =>
  fetch(`${worker.http}/v1/account`, { method: "DELETE", headers: auth(token) });
const count = async (sql: string, ...values: unknown[]) =>
  (
    await worker.db
      .prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;
const tombstones = (id: string) =>
  count("SELECT count(*) AS n FROM account_deletions WHERE account_id = ?", id);
async function addMachine(host: string, accountId: string) {
  await worker.db
    .prepare(
      "INSERT INTO machines (host_id, account_id, name, platform, created_at, last_seen_at) VALUES (?, ?, 'Box', 'linux', 1, 1)",
    )
    .bind(host, accountId)
    .run();
}

const meanwhile: [string, string, (token: string, id: string) => Promise<unknown>][] = [
  [
    "an older daemon takes the session over",
    "user_taken",
    (_token, id) =>
      worker.db
        .prepare("UPDATE sessions SET standing = 'exposed' WHERE json_extract(account, '$.id') = ?")
        .bind(id)
        .run(),
  ],
  [
    "the session signs out",
    "user_left",
    (token) =>
      fetch(`${worker.http}/v1/account/session`, { method: "DELETE", headers: auth(token) }),
  ],
];

it.each(meanwhile)(
  "no deletion is recorded when %s while the deletion reads it",
  async (_, id, change) => {
    const phone = await signIn(id);
    await addMachine((id.at(-1) ?? "X").toUpperCase().repeat(52), id);
    const held = workos.holdNext((seen) => seen.body.grant_type === "refresh_token", "before");
    const deleting = deleteAccount(phone.token);
    await held.started;
    await change(phone.token, id);
    held.release();
    expect([401, 403]).toContain((await deleting).status);
    expect(await tombstones(id)).toBe(0);
    expect(workos.deletedUsers()).not.toContain(id);
    expect(await count("SELECT count(*) AS n FROM machines WHERE account_id = ?", id)).toBe(1);
  },
);

it("while WorkOS deletes the user, the asking session can only retry: no grants, no machine credentials", async () => {
  const phone = await signIn("user_pending");
  const held = workos.holdNext((seen) => seen.method === "DELETE", "before");
  const deleting = deleteAccount(phone.token);
  try {
    await held.started;

    const grant = await fetch(`${worker.http}/v1/grants`, {
      method: "POST",
      headers: auth(phone.token),
      body: JSON.stringify({ kind: "device", subject: "phone" }),
    });
    expect(grant.status).toBe(401);
    const keys = GrantKeySet.parse(await (await fetch(`${worker.http}/v1/keys`)).json());
    const host = keyPair();
    const id = hostId(host.publicKey);
    const credential = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
    const exchange = await fetch(`${worker.http}/v1/machine-credentials`, {
      method: "POST",
      headers: { ...auth(phone.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        hostId: id,
        hostKey: encodeBase64url(host.publicKey),
        credential,
        proof: machineCredentialProof({
          hostPrivateKey: host.privateKey,
          exchangeKey: keys.exchangeKey ?? "",
          hostId: id,
          credential,
        }),
      }),
    });
    await exchange.body?.cancel();
    expect(exchange.status).toBe(401);
    expect(
      (await fetch(`${worker.http}/v1/account/session`, { headers: auth(phone.token) })).status,
    ).toBe(401);
  } finally {
    held.release();
  }
  expect((await deleting).status).toBe(200);
  expect(
    await count(
      "SELECT count(*) AS n FROM machine_credentials WHERE account_id = ?",
      "user_pending",
    ),
  ).toBe(0);
});

/** workerd keeps a closed socket's connection open for seconds: take the close frame. */
const closeOnFrame = { maxPayload: 65535, perMessageDeflate: false, closeTimeout: 500 };

it("a machine still in its handshake when the account is deleted is told to register again", async () => {
  const phone = await signIn("user_handshake");
  const keys = keyPair();
  const id = hostId(keys.publicKey);
  await addMachine(id, "user_handshake");
  // The daemon's grant was good and its socket is open, but it hasn't finished the handshake.
  const socket = new WebSocket(
    address(worker.relayUrl, "/host", { hostId: id }),
    [GRANT_SUBPROTOCOL_PREFIX + mint("machine", "user_handshake", id)],
    closeOnFrame,
  );
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  expect((await deleteAccount(phone.token)).status).toBe(200);
  expect(
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve("still open"), 3000)),
    ]),
  ).toBe(4002);
  socket.terminate();
});

it("a sign-in whose session the deletion removed reports failure and keeps no grant", async () => {
  const phone = await signIn("user_late");
  const started = await fetch(`${worker.http}/v1/account/login`, {
    method: "POST",
    headers: { Origin: allowedOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ holder: "person" }),
  });
  const flow = AceLogin.parse(await started.json());
  const { cookie, authorizeUrl } = await continueSignIn(worker.http, flow.loginUrl);
  const state = workos.authorize(authorizeUrl, person("user_late"), "code-late");
  const held = workos.hold();
  const callback = fetch(`${worker.http}/v1/account/callback?state=${state}&code=code-late`, {
    headers: { cookie },
  });
  await held.started;
  expect((await deleteAccount(phone.token)).status).toBe(200);
  held.release();
  const shown = await callback;
  await shown.body?.cancel();
  expect(shown.status).not.toBe(200);
  const claim = await fetch(`${worker.http}/v1/account/login/${flow.id}`, {
    headers: auth(flow.secret),
  });
  await claim.body?.cancel();
  expect(claim.status).not.toBe(200);
  // The sign-in's row keeps no sealed grant or account details.
  const id = createHash("sha256").update(flow.id).digest("hex");
  expect(
    await count("SELECT count(*) AS n FROM logins WHERE id = ? AND issued IS NOT NULL", id),
  ).toBe(0);
});
