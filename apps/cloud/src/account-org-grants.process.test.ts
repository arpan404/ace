import { afterAll, beforeAll, expect, it } from "vitest";
import { verifyMemberGrant, verifyOrgPolicy } from "@ace/account-grant";
import { AceOrgPolicy } from "@ace/protocol/ace-org";
import { fakeWorkos } from "./testing/fake-workos.ts";
import { startWorker } from "./testing/harness.ts";
import { orgCalls, workosUser } from "./testing/org-calls.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

/*
 * What decides org grants (ADR 0206 §1.4, §3, §4.3, §6) against the real Worker and D1, WorkOS
 * faked at its HTTP edge: the events cron that keeps the members mirror current, WorkOS's own
 * answer at most 60 seconds old behind every grant, policy versions signed with the grant key,
 * and org hosts' audit forwarding.
 */

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let api: ReturnType<typeof orgCalls>;
/** One session per person and holder for the whole file: the Worker rate-limits sign-ins. */
const sessions = new Map<string, Promise<string>>();
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({ workosUrl: workos.url });
  api = orgCalls(worker.http);
});
afterAll(async () => {
  await worker.close();
  await workos.close();
});

const owner = workosUser("user_owner", "Olivia");
const mia = workosUser("user_mia", "Mia");
function signIn(user = owner, holder: "person" | "machine" = "person"): Promise<string> {
  const key = `${user.id}:${holder}`;
  let session = sessions.get(key);
  if (!session) {
    session = signInThroughWorker(worker.http, workos, user, holder).then((grant) => grant.token);
    sessions.set(key, session);
  }
  return session;
}
const events = () => worker.cron("* * * * *");
const memberRow = async (ownerToken: string, org: string, account: string) => {
  const listed = await api.call(ownerToken, "GET", `/v1/orgs/${org}/members`);
  return (listed.body.members as { account: string }[]).find((each) => each.account === account);
};
/** An org owned by Olivia, Mia a member of it, and a host Olivia gave it. */
async function team(name: string) {
  const ownerToken = await signIn();
  const org = await api.createOrg(ownerToken, name);
  workos.orgs.addMember(mia.id, org, "member");
  await events();
  const box = await api.machine(worker.db, owner.id, await signIn(owner, "machine"));
  const enrolled = await api.enroll(ownerToken, org, box, await api.consent(box, org, owner.id));
  if (enrolled.status !== 201) throw new Error(`Enrolling failed: ${enrolled.status}`);
  return { ownerToken, org, box, miaToken: await signIn(mia) };
}

it("the events cron applies WorkOS's events in order across pages, resumes from its cursor, and is idempotent", async () => {
  const ownerToken = await signIn();
  const org = await api.createOrg(ownerToken, "Feed");
  const bob = workosUser("user_bob", "Bob");
  workos.orgs.knowUser(bob);
  workos.orgs.addMember(bob.id, org, "member");
  const firstEvent = workos.orgs.events().at(-1)?.id ?? "";
  // More than one page of events: the last role wins only if they are applied in order.
  for (let flip = 0; flip < 120; flip++)
    workos.orgs.setRole(bob.id, org, flip % 2 === 0 ? "admin" : "member");
  workos.orgs.setRole(bob.id, org, "org_reviewer");
  workos.orgs.deactivate(bob.id, org);

  const pagesBefore = workos.orgs.eventPages();
  await events();
  expect(workos.orgs.eventPages() - pagesBefore).toBeGreaterThan(1);
  const settled = { account: bob.id, email: bob.email, role: "org_reviewer", status: "inactive" };
  expect(await memberRow(ownerToken, org, bob.id)).toMatchObject(settled);

  // Nothing new: one empty page, nothing changes.
  const pagesIdle = workos.orgs.eventPages();
  await events();
  expect(workos.orgs.eventPages() - pagesIdle).toBe(1);
  expect(await memberRow(ownerToken, org, bob.id)).toMatchObject(settled);

  // A run that stopped part-way, or a cursor lost altogether: replaying lands in the same place.
  for (const cursor of [firstEvent, ""]) {
    await worker.db.prepare("UPDATE workos_events SET after = ?").bind(cursor).run();
    await events();
    expect(await memberRow(ownerToken, org, bob.id)).toMatchObject(settled);
  }

  // A later event is picked up from where the cursor stands.
  workos.orgs.addMember("user_carol", org, "member");
  await events();
  expect(await memberRow(ownerToken, org, "user_carol")).toMatchObject({ status: "active" });
});

it("an events page that deactivates a member stops their grants at the next check", async () => {
  const { org, box, miaToken } = await team("Deactivated");
  expect((await api.memberGrant(miaToken, org, box.hostId)).status).toBe(200);
  workos.orgs.deactivate(mia.id, org);
  await events();
  expect((await api.memberGrant(miaToken, org, box.hostId)).body).toEqual({ error: "not_member" });
});

it("WorkOS's answer is reused for 60 seconds; once stale, WorkOS's refusal refuses the grant", async () => {
  const { org, box, miaToken } = await team("Stale");
  const first = await api.memberGrant(miaToken, org, box.hostId);
  expect(verifyMemberGrant(String(first.body.token), await api.keys(), Date.now())).toMatchObject({
    org,
    role: "member",
    host: box.hostId,
  });
  // WorkOS no longer has Mia, but the mirror hasn't heard: a fresh check still stands.
  workos.orgs.deactivate(mia.id, org);
  expect((await api.memberGrant(miaToken, org, box.hostId)).status).toBe(200);
  await worker.db
    .prepare("UPDATE org_checks SET checked_at = checked_at - 61000 WHERE org_id = ?")
    .bind(org)
    .run();
  expect((await api.memberGrant(miaToken, org, box.hostId)).body).toEqual({
    error: "org_sign_in_required",
    org,
  });
  // Her personal session is untouched by the organization's answer.
  expect((await api.call(miaToken, "GET", "/v1/account/session")).status).toBe(200);
});

it("an organization whose sign-in policy this session didn't meet answers org_sign_in_required", async () => {
  const { ownerToken, org, box } = await team("Sso");
  workos.orgs.refuseOrg(org, "sso_required");
  await worker.db.prepare("DELETE FROM org_checks WHERE org_id = ?").bind(org).run();
  expect((await api.memberGrant(ownerToken, org, box.hostId)).body).toEqual({
    error: "org_sign_in_required",
    org,
  });
  expect((await api.call(ownerToken, "GET", `/v1/orgs/${org}/members`)).status).toBe(403);
  workos.orgs.refuseOrg(org, undefined);
});

it("member grants go only to the person's own session, for its organization's own hosts", async () => {
  const { ownerToken, org, box, miaToken } = await team("Grants");
  // A session a machine keeps never gets one.
  const daemon = await signIn(mia, "machine");
  expect((await api.memberGrant(daemon, org, box.hostId)).body).toEqual({
    error: "person_required",
  });
  // Nor does the org host's own machine credential: what a host's disk holds never speaks for a member.
  expect((await api.memberGrant(box.credential, org, box.hostId)).body).toEqual({
    error: "person_required",
  });
  // A machine of Olivia's own isn't the organization's.
  const personalBox = await api.machine(worker.db, owner.id, await signIn(owner, "machine"));
  expect((await api.memberGrant(ownerToken, org, personalBox.hostId)).body).toEqual({
    error: "not_org_host",
  });
  // Another organization's member gets nothing from this one.
  const other = await api.createOrg(await signIn(workosUser("user_zed", "Zed")), "Other");
  expect((await api.memberGrant(miaToken, other, box.hostId)).status).toBe(403);
  // The machine list is per space: the org host is the org's, not Olivia's personal machine.
  const personal = await api.call(ownerToken, "GET", "/v1/machines?space=personal");
  const hostIds = (personal.body.machines as { hostId: string }[]).map((each) => each.hostId);
  expect(hostIds).toContain(personalBox.hostId);
  expect(hostIds).not.toContain(box.hostId);
  const space = await api.call(miaToken, "GET", `/v1/machines?space=${org}`);
  expect(space.body.machines).toEqual([expect.objectContaining({ hostId: box.hostId })]);
  expect((await api.call(miaToken, "GET", `/v1/machines?space=${other}`)).status).toBe(403);
  // Only an owner releases a host.
  expect((await api.call(miaToken, "DELETE", `/v1/orgs/${org}/hosts/${box.hostId}`)).status).toBe(
    403,
  );
});

it("policy versions are signed with the grant key, only grow, and ride in member grants", async () => {
  const { ownerToken, org, box, miaToken } = await team("Policy");
  const policy = { effects: { pay: "off", publish: "approvers" }, full_access: "never" };
  expect((await api.call(miaToken, "PUT", `/v1/orgs/${org}/policy`, { policy })).status).toBe(403);
  expect(
    (
      await api.call(ownerToken, "PUT", `/v1/orgs/${org}/policy`, {
        policy: { effects: { pay: "maybe" } },
      })
    ).status,
  ).toBe(400);
  for (const version of [1, 2])
    expect(
      (await api.call(ownerToken, "PUT", `/v1/orgs/${org}/policy`, { policy })).body,
    ).toMatchObject({ version });

  const current = await api.call(miaToken, "GET", `/v1/orgs/${org}/policy`);
  const body = String(current.body.body);
  const keys = await api.keys();
  const statement = verifyOrgPolicy(String(current.body.statement), keys, body);
  expect(statement).toMatchObject({ org, version: 2, set_by: owner.id });
  expect(AceOrgPolicy.parse(JSON.parse(body))).toEqual(policy);
  // A body edited after signing no longer matches its statement.
  expect(() =>
    verifyOrgPolicy(String(current.body.statement), keys, body.replace('"off"', '"admins"')),
  ).toThrow("match");
  const grant = await api.memberGrant(miaToken, org, box.hostId);
  expect(verifyMemberGrant(String(grant.body.token), keys, Date.now()).policy).toBe(2);
});

it("an org host's audit entry sent twice is one WorkOS event; another machine can't send one", async () => {
  const { org, box } = await team("Audit");
  const hash = "a".repeat(64);
  const entry = {
    hash,
    action: "bot.effect",
    occurredAt: Date.now(),
    actor: { type: "bot", id: "ci-watcher" },
    targets: [{ type: "host", id: box.hostId }],
    metadata: { effect: "pr_comment", allowed_by: "answer:r1", args_sha256: "b".repeat(64) },
  };
  for (let send = 0; send < 2; send++)
    expect((await api.call(box.credential, "POST", `/v1/orgs/${org}/audit`, entry)).status).toBe(
      200,
    );
  const written = workos.orgs
    .audits()
    .filter(
      (each) => (each.event.metadata as Record<string, string> | undefined)?.entry_sha256 === hash,
    );
  expect(written).toEqual([expect.objectContaining({ org })]);

  const stranger = await api.machine(worker.db, owner.id, await signIn(owner, "machine"));
  expect(
    (await api.call(stranger.credential, "POST", `/v1/orgs/${org}/audit`, entry)).body,
  ).toEqual({
    error: "not_org_host",
  });
  // The host reads its organization's policy with its own credential.
  expect((await api.call(box.credential, "GET", `/v1/orgs/${org}/policy`)).body).toMatchObject({
    version: 0,
  });
});

it("a host is enrolled only with its machine's own consent, for that organization, once", async () => {
  const ownerToken = await signIn();
  const org = await api.createOrg(ownerToken, "Consent");
  const other = await api.createOrg(ownerToken, "Elsewhere");
  const box = await api.machine(worker.db, owner.id, await signIn(owner, "machine"));
  const listed = async (space: string) =>
    ((await api.call(ownerToken, "GET", `/v1/orgs/${space}/hosts`)).body.machines as {
      hostId: string;
    }[]).map((each) => each.hostId);

  // A person with `hosts:manage` naming a host isn't enough: the machine never agreed.
  const bare = await api.call(ownerToken, "POST", `/v1/orgs/${org}/hosts`, { hostId: box.hostId });
  expect(bare.status).toBe(400);
  // A consent made up without the host's key proves nothing.
  const forged = { ...(await api.consent(box, org, owner.id)), proof: "A".repeat(43) };
  expect((await api.enroll(ownerToken, org, box, forged)).body).toEqual({ error: "consent_invalid" });
  // Consent for another owner (the account the machine is signed in to, say) isn't this one's.
  const someoneElse = await api.consent(box, org, mia.id);
  expect((await api.enroll(ownerToken, org, box, someoneElse)).body).toEqual({
    error: "not_machine_owner",
  });

  // Consent to join one organization doesn't enroll it in another, respelled or not.
  const forOrg = await api.consent(box, org, owner.id);
  expect((await api.enroll(ownerToken, other, box, forOrg)).body).toEqual({
    error: "consent_mismatch",
  });
  expect((await api.enroll(ownerToken, other, box, { ...forOrg, org: other })).body).toEqual({
    error: "consent_invalid",
  });
  expect(await listed(other)).not.toContain(box.hostId);

  // With it, once.
  expect((await api.enroll(ownerToken, org, box, forOrg)).status).toBe(201);
  expect(await listed(org)).toContain(box.hostId);
  // The same consent again is spent, even after the host is released.
  expect((await api.call(ownerToken, "DELETE", `/v1/orgs/${org}/hosts/${box.hostId}`)).status).toBe(
    200,
  );
  expect((await api.enroll(ownerToken, org, box, forOrg)).body).toEqual({ error: "consent_used" });
  expect(await listed(org)).not.toContain(box.hostId);
});
