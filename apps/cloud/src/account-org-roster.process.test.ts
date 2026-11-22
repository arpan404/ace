import { afterAll, beforeAll, expect, it } from "vitest";
import { encodeBase64url, verifyOrgRoster } from "@ace/account-grant";
import { AceOrgRoster, AceOrgRosterBody } from "@ace/protocol/ace-org";
import { fakeWorkos } from "./testing/fake-workos.ts";
import { startWorker } from "./testing/harness.ts";
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

it("an org host's roster is signed for it, and a removal gives it a higher version without the member", async () => {
  const owner = workosUser("user_rosterowner", "Rosterowner");
  const mia = workosUser("user_rostermia", "Rostermia");
  const ownerToken = (await signInThroughWorker(worker.http, workos, owner)).token;
  const org = await api.createOrg(ownerToken, "Rostered");
  workos.orgs.addMember(mia.id, org, "member");
  await worker.cron("* * * * *");
  const daemonSession = (await signInThroughWorker(worker.http, workos, owner, "machine")).token;
  const box = await api.machine(worker.db, owner.id, daemonSession);
  expect(
    (await api.enroll(ownerToken, org, box, await api.consent(box, org, owner.id))).status,
  ).toBe(201);
  const credential = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
  expect((await api.orgCredential(box, org, credential)).status).toBe(201);

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
