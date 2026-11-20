import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { AceLogin } from "@ace/protocol/ace-account";
import { connectClientViaRelay, connectHostToRelay } from "@ace/relay";
import { hostId, keyPair } from "@ace/secure-channel";
import { fakeWorkos } from "./testing/fake-workos.ts";
import type { WorkosUser } from "./testing/fake-workos.ts";
import { allowedOrigin, mint, startWorker } from "./testing/harness.ts";
import { continueSignIn, signInThroughWorker } from "./testing/sign-in.ts";

// Deleting an account spans the Worker's routing, its D1 rows and a WorkOS request together.
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
const session = (token: string) =>
  fetch(`${worker.http}/v1/account/session`, { headers: auth(token) });
const machines = (token: string) => fetch(`${worker.http}/v1/machines`, { headers: auth(token) });
const deleteAccount = (token?: string) =>
  fetch(`${worker.http}/v1/account`, { method: "DELETE", headers: token ? auth(token) : {} });
const signIn = (id: string, holder: "person" | "machine" = "person") =>
  signInThroughWorker(worker.http, workos, person(id), holder);

async function addMachine(host: string, accountId: string) {
  await worker.db
    .prepare(
      "INSERT INTO machines (host_id, account_id, name, platform, created_at, last_seen_at) VALUES (?, ?, 'Box', 'linux', 1, 1)",
    )
    .bind(host, accountId)
    .run();
}
const count = async (sql: string, ...values: unknown[]) =>
  (
    await worker.db
      .prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;

it("deleting an account removes it at WorkOS and ends its sessions, machines and sign-ins on every device", async () => {
  const phone = await signIn("user_gone");
  const laptop = await signIn("user_gone");
  const other = await signIn("user_stays");
  await addMachine("A".repeat(52), "user_gone");
  await addMachine("B".repeat(52), "user_gone");
  await addMachine("C".repeat(52), "user_stays");

  const deleted = await deleteAccount(phone.token);
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: true });
  expect(workos.deletedUsers()).toContain("user_gone");

  for (const token of [phone.token, laptop.token]) {
    expect((await session(token)).status).toBe(401);
    expect((await machines(token)).status).toBe(401);
    expect((await deleteAccount(token)).status).toBe(401);
  }
  expect(await count("SELECT count(*) AS n FROM machines WHERE account_id = ?", "user_gone")).toBe(
    0,
  );
  // The sign-ins that issued the deleted sessions go with them.
  expect(
    await count(
      "SELECT count(*) AS n FROM logins WHERE session IS NOT NULL AND session NOT IN (SELECT token FROM sessions)",
    ),
  ).toBe(0);

  // Another account keeps its session and machines.
  expect((await session(other.token)).status).toBe(200);
  expect(await (await machines(other.token)).json()).toMatchObject({
    machines: [{ hostId: "C".repeat(52) }],
  });
});

async function addMachineSignIn(host: string, accountId: string) {
  await worker.db.batch([
    worker.db
      .prepare(
        "INSERT INTO machine_credentials (token, session, host_id, account_id, expires, sole, created_at) VALUES (?, 'session', ?, ?, 9e15, 0, 1)",
      )
      .bind(`credential-${host}`, host, accountId),
    worker.db
      .prepare(
        "INSERT INTO machine_enrollments (ticket, session, host_id, account_id, expires) VALUES (?, 'session', ?, ?, 9e15)",
      )
      .bind(`ticket-${host}`, host, accountId),
  ]);
}

it("deleting an account removes its machine credentials and enrollment tickets, and no other account's", async () => {
  const phone = await signIn("user_credentials");
  await addMachineSignIn("F".repeat(52), "user_credentials");
  await addMachineSignIn("G".repeat(52), "user_keeps_credentials");
  workos.failDeletes(true);
  // Even when WorkOS fails, no machine keeps a way back in while the person retries.
  expect((await deleteAccount(phone.token)).status).toBe(502);
  for (const table of ["machine_credentials", "machine_enrollments"]) {
    const n = `SELECT count(*) AS n FROM ${table} WHERE account_id = ?`;
    expect(await count(n, "user_credentials")).toBe(0);
    expect(await count(n, "user_keeps_credentials")).toBe(1);
  }
});

it("a WorkOS failure keeps the asking session, so trying again finishes the deletion", async () => {
  const grant = await signIn("user_retry");
  const otherDevice = await signIn("user_retry");
  await addMachine("D".repeat(52), "user_retry");
  workos.failDeletes(true);
  expect((await deleteAccount(grant.token)).status).toBe(502);
  expect(workos.deletedUsers()).not.toContain("user_retry");
  // The asking phone can still retry; everything else ace held is already gone.
  expect((await session(grant.token)).status).toBe(200);
  expect((await session(otherDevice.token)).status).toBe(401);
  expect(await count("SELECT count(*) AS n FROM machines WHERE account_id = ?", "user_retry")).toBe(
    0,
  );

  workos.failDeletes(false);
  expect((await deleteAccount(grant.token)).status).toBe(200);
  expect(workos.deletedUsers()).toContain("user_retry");
  expect((await session(grant.token)).status).toBe(401);
});

/** WorkOS loses the user without ace hearing of it, as if its delete went through. */
const deleteAtWorkos = (id: string) =>
  fetch(`${workos.url}/user_management/users/${id}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer sk_test_backend" },
  });
const leftFor = (accountId: string) =>
  count("SELECT count(*) AS n FROM sessions WHERE json_extract(account, '$.id') = ?", accountId);

it("a retry from the asking phone finishes a deletion WorkOS already completed", async () => {
  const phone = await signIn("user_half");
  workos.failDeletes(true);
  expect((await deleteAccount(phone.token)).status).toBe(502);
  workos.failDeletes(false);
  // WorkOS deleted the user, but ace never heard back: the session can no longer refresh.
  expect((await deleteAtWorkos("user_half")).status).toBe(202);
  const retried = await deleteAccount(phone.token);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual({ deleted: true });
  expect(await leftFor("user_half")).toBe(0);
  expect((await deleteAccount(phone.token)).status).toBe(401);
});

it("the sweep finishes a deletion the phone never retried", async () => {
  const phone = await signIn("user_abandoned");
  await addMachine("H".repeat(52), "user_abandoned");
  workos.failDeletes(true);
  expect((await deleteAccount(phone.token)).status).toBe(502);
  workos.failDeletes(false);
  await worker.sweep();
  expect(workos.deletedUsers()).toContain("user_abandoned");
  expect(await leftFor("user_abandoned")).toBe(0);
  expect((await session(phone.token)).status).toBe(401);
});

it("only the person's own session deletes the account: a machine's or an older one's is refused", async () => {
  const machine = await signIn("user_guarded", "machine");
  const older = await signIn("user_guarded");
  await worker.db
    .prepare("UPDATE sessions SET standing = 'legacy' WHERE json_extract(account, '$.id') = ?")
    .bind("user_guarded")
    .run();
  await addMachine("J".repeat(52), "user_guarded");
  for (const token of [machine.token, older.token]) {
    const refused = await deleteAccount(token);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "person_session_required" });
  }
  expect(workos.deletedUsers()).not.toContain("user_guarded");
  expect((await session(older.token)).status).toBe(200);
  expect(
    await count("SELECT count(*) AS n FROM machines WHERE account_id = ?", "user_guarded"),
  ).toBe(1);
});

it("a sign-in still in flight when the account is deleted gets no session", async () => {
  const phone = await signIn("user_racing");
  // Another device's sign-in has reached WorkOS but not yet come back.
  const started = await fetch(`${worker.http}/v1/account/login`, {
    method: "POST",
    headers: { Origin: allowedOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ holder: "person" }),
  });
  const flow = AceLogin.parse(await started.json());
  const { cookie, authorizeUrl } = await continueSignIn(worker.http, flow.loginUrl);
  const state = workos.authorize(authorizeUrl, person("user_racing"), "code-racing");
  expect((await deleteAccount(phone.token)).status).toBe(200);
  const callback = await fetch(
    `${worker.http}/v1/account/callback?state=${state}&code=code-racing`,
    { headers: { cookie } },
  );
  await callback.body?.cancel();
  expect(callback.status).not.toBe(200);
  expect(await leftFor("user_racing")).toBe(0);
});

it("a machine grant issued before the deletion can't put the machine back on the account", async () => {
  const phone = await signIn("user_regrant");
  const hostKeys = keyPair();
  const grant = mint("machine", "user_regrant", hostId(hostKeys.publicKey));
  expect((await deleteAccount(phone.token)).status).toBe(200);
  const outcome = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys,
    account: { grant: async () => grant, name: "Late box", platform: "linux" },
    onClientChannel: () => {},
  }).then(
    async (host) => {
      await host.close();
      return "connected";
    },
    () => "refused",
  );
  expect(outcome).toBe("refused");
  expect(
    await count("SELECT count(*) AS n FROM machines WHERE account_id = ?", "user_regrant"),
  ).toBe(0);
});

it("a machine still connected to the relay drops off when its account is deleted", async () => {
  const phone = await signIn("user_connected");
  // The machine's own `ace login`, which asks for its machine grants.
  const grant = await signIn("user_connected", "machine");
  const hostKeys = keyPair();
  const machineGrant = async () => {
    const response = await fetch(`${worker.http}/v1/grants`, {
      method: "POST",
      headers: auth(grant.token),
      body: JSON.stringify({ kind: "machine", subject: hostId(hostKeys.publicKey) }),
    });
    if (!response.ok) throw new Error(`Grant refused: ${response.status}`);
    return z.object({ token: z.string() }).parse(await response.json()).token;
  };
  const machine = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys,
    account: { grant: machineGrant, name: "Build box", platform: "linux" },
    onClientChannel: () => {},
  });
  try {
    const device = () =>
      connectClientViaRelay({
        relayUrl: worker.relayUrl,
        hostId: machine.hostId,
        pinnedFingerprint: machine.hostId,
        grant: mint("device", "user_connected", "phone"),
      });
    await (await device()).close();
    expect((await deleteAccount(phone.token)).status).toBe(200);
    // Told to register again, the machine has no session to do it with.
    await expect(device()).rejects.toThrow();
  } finally {
    await machine.close();
  }
});

it("the sweep forgets a finished deletion after 30 days, and keeps a recent one", async () => {
  const day = 86_400_000;
  await worker.db.batch(
    [
      ["user_long_gone", Date.now() - 31 * day],
      ["user_just_gone", Date.now() - day],
    ].map(([id, at]) =>
      worker.db
        .prepare(
          "INSERT INTO account_deletions (account_id, session, started_at, finished_at) VALUES (?, '', ?, ?)",
        )
        .bind(id, at, at),
    ),
  );
  await worker.sweep();
  const kept = await worker.db
    .prepare(
      "SELECT account_id FROM account_deletions WHERE account_id IN ('user_long_gone', 'user_just_gone')",
    )
    .all<{ account_id: string }>();
  expect(kept.results.map((row) => row.account_id)).toEqual(["user_just_gone"]);
});

it("deleting an account needs its session", async () => {
  expect((await deleteAccount()).status).toBe(401);
  expect((await deleteAccount("x".repeat(43))).status).toBe(401);
});
