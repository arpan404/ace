import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { connectClientViaRelay, connectHostToRelay } from "@ace/relay";
import { hostId, keyPair } from "@ace/secure-channel";
import { fakeWorkos } from "./testing/fake-workos.ts";
import type { WorkosUser } from "./testing/fake-workos.ts";
import { mint, startWorker } from "./testing/harness.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

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
const signIn = (id: string) => signInThroughWorker(worker.http, workos, person(id));

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

it("an account WorkOS no longer has is still deleted from ace", async () => {
  const first = await signIn("user_twice");
  expect((await deleteAccount(first.token)).status).toBe(200);
  // A session left from before WorkOS lost the user: WorkOS now answers 404 for it.
  const again = await signIn("user_twice");
  await addMachine("E".repeat(52), "user_twice");
  expect((await deleteAccount(again.token)).status).toBe(200);
  expect((await session(again.token)).status).toBe(401);
  expect(await count("SELECT count(*) AS n FROM machines WHERE account_id = ?", "user_twice")).toBe(
    0,
  );
});

it("a machine still connected to the relay drops off when its account is deleted", async () => {
  const grant = await signIn("user_connected");
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
    expect((await deleteAccount(grant.token)).status).toBe(200);
    // Told to register again, the machine has no session to do it with.
    await expect(device()).rejects.toThrow();
  } finally {
    await machine.close();
  }
});

it("deleting an account needs its session", async () => {
  expect((await deleteAccount()).status).toBe(401);
  expect((await deleteAccount("x".repeat(43))).status).toBe(401);
});
