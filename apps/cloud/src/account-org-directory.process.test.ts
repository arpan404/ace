import { createHmac } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GRANT_SUBPROTOCOL_PREFIX } from "@ace/account-grant";
import { fakeWorkos } from "./testing/fake-workos.ts";
import { startWorker, upgrade } from "./testing/harness.ts";
import { orgCalls, workosUser } from "./testing/org-calls.ts";
import { signInThroughWorker } from "./testing/sign-in.ts";

/*
 * Directory deprovisioning (ADR 0206 §6) against the real Worker and D1, WorkOS faked at its
 * HTTP edge: WorkOS's signed webhook deliveries end a member's org access at once, without the
 * minute's Events API run, and every change the directory makes is in the org's audit log.
 */

const SECRET = "whsec_test_directory_sync_secret";
let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let api: ReturnType<typeof orgCalls>;
const sessions = new Map<string, Promise<string>>();
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({
    workosUrl: workos.url,
    vars: { WORKOS_WEBHOOK_SECRET: SECRET },
  });
  api = orgCalls(worker.http);
});
afterAll(async () => {
  await worker.close();
  await workos.close();
});

const owner = workosUser("user_dirowner", "Dora");
function signIn(user: ReturnType<typeof workosUser>, holder: "person" | "machine" = "person") {
  const key = `${user.id}:${holder}`;
  let session = sessions.get(key);
  if (!session) {
    session = signInThroughWorker(worker.http, workos, user, holder).then((grant) => grant.token);
    sessions.set(key, session);
  }
  return session;
}

type Delivery = { id: string; event: string; data: unknown; created_at: string };
/** Posts `event` to the webhook as WorkOS would: signed at `at` with `secret`. */
async function deliver(
  event: Delivery,
  options: { secret?: string; at?: number; header?: string | null; body?: string } = {},
) {
  const body = options.body ?? JSON.stringify(event);
  const at = options.at ?? Date.now();
  const mac = createHmac("sha256", options.secret ?? SECRET)
    .update(`${at}.${JSON.stringify(event)}`)
    .digest("hex");
  const header = options.header === undefined ? `t=${at}, v1=${mac}` : options.header;
  const response = await fetch(`${worker.http}/v1/workos/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(header ? { "WorkOS-Signature": header } : {}),
    },
    body,
  });
  return response.status;
}
const lastEvent = (): Delivery => {
  const event = workos.orgs.events().at(-1);
  if (!event) throw new Error("WorkOS made no event");
  return event;
};
const memberRow = async (ownerToken: string, org: string, account: string) => {
  const listed = await api.call(ownerToken, "GET", `/v1/orgs/${org}/members`);
  return (listed.body.members as { account: string }[]).find((each) => each.account === account);
};
const auditsFor = (org: string, action: string) =>
  workos.orgs
    .audits()
    .filter((each) => each.org === org && each.event.action === action)
    .map((each) => each.event);

/** An org owned by Dora with a host, and `person` a directory-managed member of it. */
async function team(name: string, person: ReturnType<typeof workosUser>) {
  const ownerToken = await signIn(owner);
  const org = await api.createOrg(ownerToken, name);
  workos.orgs.addMember(person.id, org, "member", { directory_managed: true });
  await worker.cron("* * * * *");
  const box = await api.machine(worker.db, owner.id, await signIn(owner, "machine"));
  const enrolled = await api.enroll(ownerToken, org, box, await api.consent(box, org, owner.id));
  if (enrolled.status !== 201) throw new Error(`Enrolling failed: ${enrolled.status}`);
  return { ownerToken, org, box, token: await signIn(person) };
}

it("a user the directory deactivates loses org access at once, and their live grant no longer opens the host", async () => {
  const nia = workosUser("user_nia", "Nia");
  const { ownerToken, org, box, token } = await team("Deprovisioned", nia);
  const live = await api.memberGrant(token, org, box.hostId);
  expect(live.status).toBe(200);
  const relay = () =>
    upgrade(`${worker.relayUrl}/client?hostId=${box.hostId}`, [
      GRANT_SUBPROTOCOL_PREFIX + String(live.body.token),
    ]);
  // While she is a member, the relay admits her grant (the host just isn't connected).
  expect(await relay()).not.toEqual({ status: 403 });

  workos.orgs.deactivate(nia.id, org);
  expect(await deliver(lastEvent())).toBe(200);

  // No Events API run in between: the delivery alone ended it.
  expect((await api.memberGrant(token, org, box.hostId)).body).toEqual({ error: "not_member" });
  expect((await api.call(token, "GET", `/v1/orgs/${org}/members`)).status).toBe(403);
  // The grant she already holds hasn't expired, and still opens nothing.
  expect(await relay()).toEqual({ status: 403 });
  expect(await memberRow(ownerToken, org, nia.id)).toMatchObject({ status: "inactive" });
  // On the organization's record, as the directory's doing, with names of roles only.
  const [entry] = auditsFor(org, "org.member.deprovisioned");
  expect(entry).toMatchObject({
    actor: { type: "idp" },
    targets: [{ type: "member", id: nia.id }],
    metadata: { status_before: "active", status_after: "inactive" },
  });
  expect(JSON.stringify(entry)).not.toContain(nia.email);
});

it("an identity provider's role change takes effect at the next request and is audited as the directory's", async () => {
  const omar = workosUser("user_omar", "Omar");
  const { ownerToken, org, token } = await team("Promoted", omar);
  // A member can't manage invitations; his org check is fresh, within its 60 seconds.
  expect((await api.call(token, "GET", `/v1/orgs/${org}/invitations`)).status).toBe(403);

  workos.orgs.setRole(omar.id, org, "admin");
  expect(await deliver(lastEvent())).toBe(200);

  expect((await api.call(token, "GET", `/v1/orgs/${org}/invitations`)).status).toBe(200);
  expect(await memberRow(ownerToken, org, omar.id)).toMatchObject({
    role: "admin",
    directoryManaged: true,
  });
  // The role is the identity provider's: ace's pages can't change it.
  expect(
    (await api.call(ownerToken, "PATCH", `/v1/orgs/${org}/members/${omar.id}`, { role: "member" }))
      .body,
  ).toEqual({ error: "directory_managed" });
  expect(auditsFor(org, "org.member.role_changed")).toEqual([
    expect.objectContaining({
      actor: { type: "idp", id: "directory" },
      metadata: expect.objectContaining({ role_before: "member", role_after: "admin" }),
    }),
  ]);
});

it("a repeated or out-of-order delivery changes nothing, and the Events API replaying it neither", async () => {
  const pia = workosUser("user_pia", "Pia");
  const { ownerToken, org } = await team("Reordered", pia);
  workos.orgs.setRole(pia.id, org, "admin");
  const promoted = lastEvent();
  workos.orgs.setRole(pia.id, org, "member");
  const demoted = lastEvent();

  // In order, then the earlier one late, then each again.
  for (const event of [promoted, demoted, promoted, demoted, promoted])
    expect(await deliver(event)).toBe(200);
  expect(await memberRow(ownerToken, org, pia.id)).toMatchObject({ role: "member" });

  // The Events API brings the same events again, in order: the row ends where WorkOS has it.
  await worker.cron("* * * * *");
  expect(await memberRow(ownerToken, org, pia.id)).toMatchObject({ role: "member" });
  // One entry per change WorkOS made, never one per delivery.
  const changes = auditsFor(org, "org.member.role_changed");
  expect(changes.map((each) => each.metadata)).toEqual([
    expect.objectContaining({
      role_before: "member",
      role_after: "admin",
      workos_event: promoted.id,
    }),
    expect.objectContaining({
      role_before: "admin",
      role_after: "member",
      workos_event: demoted.id,
    }),
  ]);
});

it("an event that arrives after a later one is ignored", async () => {
  const sam = workosUser("user_sam", "Sam");
  const { ownerToken, org } = await team("Late", sam);
  workos.orgs.deactivate(sam.id, org);
  const deactivated = lastEvent();
  workos.orgs.setRole(sam.id, org, "admin");
  const promoted = lastEvent();
  // The later one first: the earlier deactivation, arriving after it, doesn't take him out.
  // (WorkOS's own later event carries the state as it stands: inactive, admin.)
  expect(await deliver(promoted)).toBe(200);
  expect(await deliver(deactivated)).toBe(200);
  expect(await memberRow(ownerToken, org, sam.id)).toMatchObject({
    role: "admin",
    status: "inactive",
  });
  // Re-activated by the directory, a stale copy of the deactivation changes nothing either.
  workos.orgs.reactivate(sam.id, org);
  expect(await deliver(lastEvent())).toBe(200);
  expect(await deliver(deactivated)).toBe(200);
  expect(await memberRow(ownerToken, org, sam.id)).toMatchObject({ status: "active" });
  expect(auditsFor(org, "org.member.deprovisioned")).toHaveLength(1);
  expect(auditsFor(org, "org.member.reactivated")).toHaveLength(1);
});

it("a forged, altered, stale or unsigned delivery is refused and changes nothing", async () => {
  const quinn = workosUser("user_quinn", "Quinn");
  const { ownerToken, org, box, token } = await team("Forged", quinn);
  // An event WorkOS never sent: Quinn deactivated.
  const forged: Delivery = {
    id: "event_01FORGED",
    event: "organization_membership.updated",
    data: {
      ...workos.orgs.membership(quinn.id, org),
      status: "inactive",
      updated_at: new Date(Date.now() + 60_000).toISOString(),
    },
    created_at: new Date(Date.now() + 60_000).toISOString(),
  };
  expect(await deliver(forged, { secret: "whsec_someone_else_entirely" })).toBe(401);
  expect(await deliver(forged, { header: null })).toBe(401);
  expect(await deliver(forged, { header: "t=1, v1=00" })).toBe(401);
  expect(await deliver(forged, { at: Date.now() - 10 * 60_000 })).toBe(401);
  expect(await deliver(forged, { body: JSON.stringify({ ...forged, id: "event_01OTHER" }) })).toBe(
    401,
  );

  expect(await memberRow(ownerToken, org, quinn.id)).toMatchObject({ status: "active" });
  expect((await api.memberGrant(token, org, box.hostId)).status).toBe(200);
  expect(auditsFor(org, "org.member.deprovisioned")).toEqual([]);
});

it("deprovisioning and a deleted user delete nothing personal, and the organization keeps its host", async () => {
  const rae = workosUser("user_rae", "Rae");
  const { ownerToken, org, box, token } = await team("Personal", rae);
  const own = await api.machine(worker.db, rae.id, await signIn(rae, "machine"));
  const personalMachines = async () => {
    const listed = await api.call(token, "GET", "/v1/machines?space=personal");
    return (listed.body.machines as { hostId: string }[]).map((each) => each.hostId);
  };
  expect(await personalMachines()).toContain(own.hostId);

  workos.orgs.deactivate(rae.id, org);
  expect(await deliver(lastEvent())).toBe(200);
  // Her account, session and machines are hers as before.
  expect((await api.call(token, "GET", "/v1/account/session")).status).toBe(200);
  expect(await personalMachines()).toContain(own.hostId);
  expect((await api.call(token, "GET", "/v1/orgs")).body.orgs).toEqual([]);

  // WorkOS deletes the user: every membership is marked removed, never a row of hers deleted.
  const deleted: Delivery = {
    id: "event_01RAEGONE",
    event: "user.deleted",
    data: { object: "user", id: rae.id, email: rae.email, first_name: "Rae" },
    created_at: new Date(Date.now() + 1_000).toISOString(),
  };
  expect(await deliver(deleted)).toBe(200);
  expect(await memberRow(ownerToken, org, rae.id)).toBeUndefined();
  const kept = await worker.db
    .prepare("SELECT status FROM org_members WHERE org_id = ? AND account_id = ?")
    .bind(org, rae.id)
    .first();
  expect(kept).toEqual({ status: "removed" });
  const machine = await worker.db
    .prepare("SELECT account_id FROM machines WHERE host_id = ?")
    .bind(own.hostId)
    .first();
  expect(machine).toEqual({ account_id: rae.id });
  // The organization still holds its host, and its owner still opens it.
  const hosts = await api.call(ownerToken, "GET", `/v1/orgs/${org}/hosts`);
  expect(hosts.body.machines).toEqual([expect.objectContaining({ hostId: box.hostId })]);
  expect((await api.memberGrant(ownerToken, org, box.hostId)).status).toBe(200);
});
