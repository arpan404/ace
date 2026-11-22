import { afterAll, beforeAll, expect, it } from "vitest";
import { encodeBase64url, verifyOrgRoster } from "@ace/account-grant";
import { AceOrgRoster, AceOrgRosterBody } from "@ace/protocol/ace-org";
import { fakeWorkos } from "./testing/fake-workos.ts";
import { startWorker } from "./testing/harness.ts";
import { claimRosterVersion, rosterSnapshot } from "./account/org-roster.ts";
import { orgCalls, workosUser } from "./testing/org-calls.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

/*
 * An org host's member roster (ADR 0209 §7.2) against the real Worker and D1, WorkOS faked at its
 * HTTP edge: served only to the host's own organization credential, signed for that host, and
 * given a higher version whenever the members change, so a host that refuses lower versions
 * can't be handed one that still lists a removed member.
 */

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let api: ReturnType<typeof orgCalls>;
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({ workosUrl: workos.url });
  api = orgCalls(worker.http);
});
afterAll(async () => {
  await worker.close();
  await workos.close();
});

const rosterPath = (org: string, hostId: string) => `/v1/orgs/${org}/hosts/${hostId}/roster`;

/** A verified roster for `box`, as its daemon reads it. */
async function roster(credential: string, org: string, hostId: string) {
  const answer = await api.call(credential, "GET", rosterPath(org, hostId));
  expect(answer.status).toBe(200);
  const { body, statement } = AceOrgRoster.parse(answer.body);
  const signed = verifyOrgRoster(statement, await api.keys(), body);
  return { signed, members: AceOrgRosterBody.parse(JSON.parse(body)).members };
}

/** An organization with an owner and Mia, and a host enrolled in it with its own credential. */
async function rosteredHost(name: string) {
  const owner = workosUser(`user_${name.toLowerCase()}owner`, `${name}owner`);
  const mia = workosUser(`user_${name.toLowerCase()}mia`, `${name}mia`);
  const ownerToken = (await signInThroughWorker(worker.http, workos, owner)).token;
  const org = await api.createOrg(ownerToken, name);
  workos.orgs.addMember(mia.id, org, "member");
  await worker.cron("* * * * *");
  const daemonSession = (await signInThroughWorker(worker.http, workos, owner, "machine")).token;
  const box = await api.machine(worker.db, owner.id, daemonSession);
  expect(
    (await api.enroll(ownerToken, org, box, await api.consent(box, org, owner.id))).status,
  ).toBe(201);
  const credential = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
  expect((await api.orgCredential(box, org, credential)).status).toBe(201);
  return { owner, mia, ownerToken, org, box, credential };
}

it("an org host's roster is signed for it, and a removal gives it a higher version without the member", async () => {
  const { mia, ownerToken, org, box, credential } = await rosteredHost("Rostered");

  const first = await roster(credential, org, box.hostId);
  expect(first.signed).toMatchObject({ org, host: box.hostId, kind: "org-roster" });
  expect(first.members).toContainEqual(
    expect.objectContaining({ account: mia.id, status: "active", role: "member" }),
  );
  // Nothing changed: the same version again, signed afresh.
  const again = await roster(credential, org, box.hostId);
  expect(again.signed.version).toBe(first.signed.version);
  expect(again.signed.at).toBeGreaterThanOrEqual(first.signed.at);

  expect((await api.call(ownerToken, "DELETE", `/v1/orgs/${org}/members/${mia.id}`)).status).toBe(
    200,
  );
  const after = await roster(credential, org, box.hostId);
  expect(after.signed.version).toBeGreaterThan(first.signed.version);
  expect(after.members.filter((member) => member.status === "active")).not.toContainEqual(
    expect.objectContaining({ account: mia.id }),
  );

  // Nobody else reads it: not an owner's own session, not the enroller's machine credential, and not
  // the host's own credential for another host id.
  expect((await api.call(ownerToken, "GET", rosterPath(org, box.hostId))).status).toBe(403);
  expect((await api.call(box.credential, "GET", rosterPath(org, box.hostId))).status).toBe(403);
  const unsigned = await fetch(`${worker.http}${rosterPath(org, box.hostId)}`);
  expect(unsigned.status).toBe(401);
  const elsewhere = "A".repeat(52);
  expect((await api.call(credential, "GET", rosterPath(org, elsewhere))).status).toBe(403);
});

it("a roster read before a removal never takes a version after it", async () => {
  const { mia, ownerToken, org, box, credential } = await rosteredHost("Stalled");
  const first = await roster(credential, org, box.hostId);
  expect(first.signed.epoch).toBe(1);
  // Ben joins, so the next roster differs from the one served. One request reads it, Mia still
  // active, and stalls while the removal lands.
  const ben = workosUser("user_stalledben", "Stalledben");
  workos.orgs.addMember(ben.id, org, "member");
  await worker.cron("* * * * *");
  const stale = await rosterSnapshot(worker.db, org, Date.now());
  expect((await api.call(ownerToken, "DELETE", `/v1/orgs/${org}/members/${mia.id}`)).status).toBe(
    200,
  );
  // It wakes first: what it read is no longer the members, so it takes no version.
  expect(await claimRosterVersion(worker.db, org, stale, 1)).toBeUndefined();
  const served = await roster(credential, org, box.hostId);
  expect(served.signed).toMatchObject({ version: first.signed.version + 1, epoch: 1 });
  // Mia is listed as removed, with the time WorkOS made that so, never active.
  expect(served.members).toContainEqual(
    expect.objectContaining({ account: mia.id, status: "removed", changed: expect.any(String) }),
  );
  expect(served.members).toContainEqual(
    expect.objectContaining({ account: ben.id, status: "active" }),
  );
});

it("a stale read of the body already served can't sign it afresh after a removal", async () => {
  const { mia, ownerToken, org, box, credential } = await rosteredHost("Resigned");
  const first = await roster(credential, org, box.hostId);
  // A request reads the very body that was served, then stalls while the removal lands and no
  // other request versions it yet.
  const stale = await rosterSnapshot(worker.db, org, Date.now());
  expect((await api.call(ownerToken, "DELETE", `/v1/orgs/${org}/members/${mia.id}`)).status).toBe(
    200,
  );
  // It wakes: re-serving its body as current would extend Mia's roster past her removal.
  expect(await claimRosterVersion(worker.db, org, stale, 1)).toBeUndefined();
  const served = await roster(credential, org, box.hostId);
  expect(served.signed.version).toBe(first.signed.version + 1);
  // A roster is dated by the read it was made from, never later than the answer.
  expect(served.signed.at).toBeLessThanOrEqual(Date.now());
});

it("a backend whose roster epoch is behind what it already served refuses to serve one", async () => {
  const { org, box, credential } = await rosteredHost("Floor");
  await roster(credential, org, box.hostId);
  // As if the Worker were redeployed with an older epoch than the database has seen.
  await worker.db.prepare("UPDATE org_rosters SET epoch = 7 WHERE org_id = ?").bind(org).run();
  const answer = await api.call(credential, "GET", rosterPath(org, box.hostId));
  expect(answer).toEqual({ status: 503, body: { error: "roster_epoch_behind" } });
});

it("a backend with no roster epoch configured serves no roster, and says why", async () => {
  const unset = await startWorker({ workosUrl: workos.url, vars: { ACE_ROSTER_EPOCH: "" } });
  try {
    const calls = orgCalls(unset.http);
    const owner = workosUser("user_unsetowner", "Unsetowner");
    const ownerToken = (await signInThroughWorker(unset.http, workos, owner)).token;
    const org = await calls.createOrg(ownerToken, "Unset");
    const daemonSession = (await signInThroughWorker(unset.http, workos, owner, "machine")).token;
    const box = await calls.machine(unset.db, owner.id, daemonSession);
    expect(
      (await calls.enroll(ownerToken, org, box, await calls.consent(box, org, owner.id))).status,
    ).toBe(201);
    const credential = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
    expect((await calls.orgCredential(box, org, credential)).status).toBe(201);
    const answer = await calls.call(credential, "GET", rosterPath(org, box.hostId));
    expect(answer).toEqual({ status: 503, body: { error: "roster_epoch_unset" } });
  } finally {
    await unset.close();
  }
});
